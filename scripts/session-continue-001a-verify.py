#!/usr/bin/env python3
"""Ordinary three-process stub continuation; no embedded Host on this route."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parent.parent
spec = spec_from_file_location('ordinary_demo', ROOT / 'scripts/session-demo-001b-verify.py')
demo = module_from_spec(spec)
spec.loader.exec_module(demo)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-parent', type=Path, default=Path(tempfile.gettempdir()))
    options = parser.parse_args()
    evidence = Path(tempfile.mkdtemp(prefix='ordinary-continue-', dir=options.evidence_parent))
    print('EVIDENCE ' + str(evidence), flush=True)
    paths = list((ROOT / 'src').rglob('*.es')) + [ROOT / name for name in (
        'etas.toml', 'etas.lock', 'compose.yaml', 'Dockerfile', 'scripts/session-demo.sh',
        'config/session-demo-compose.yaml', 'config/etas-runtime-cache-compose.yaml',
        'tests/normal_graph_identity.py', 'scripts/etas-latest-cli-bootstrap.py', 'config/etas-latest-main.json',
        'scripts/etas-012-official-cli-bootstrap.py', 'config/etas-012-official.json', 'config/etas-012-official.Cargo.lock',
        'scripts/session-continue-001a-verify.py',
        'scripts/session-demo-001b-verify.py')]
    hashes = {str(p.relative_to(ROOT)): demo.digest(p) for p in paths}
    for p in paths:
        target = evidence / 'inputs' / p.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target)
    result = {'status': 'running', 'sources_before': hashes, 'commands': [], 'passed': [],
              'scope': 'normal installed CLI and real separate Docker invocations; SQLite observations are data-only'}

    def record():
        (evidence / 'results.json').write_text(json.dumps(result, indent=2))

    def invoke(label, verb, database, caps=(3, 16), text=None, save='save1', generation=0, next_save='save2', binding=demo.BINDING):
        args = ['bash', str(ROOT / 'scripts/session-demo.sh'), verb, str(database), '--session', 'continue-demo',
                '--save', save, '--binding', binding, '--steps', str(caps[0]), '--budget', str(caps[1])]
        if verb == 'continue':
            args += ['--generation', str(generation), '--next-save', next_save]
        if text is not None:
            args += ['--input', text]
        item = {'label': label, 'command': args}
        result['commands'].append(item)
        record()
        run = subprocess.run(args, capture_output=True, text=True, timeout=150)
        item.update(exit=run.returncode, stdout=run.stdout, stderr=run.stderr)
        state, raw = demo.inspect_store(database)
        item['database'] = state
        (evidence / (label + '.dump.json')).write_text(json.dumps(raw, indent=2))
        record()
        return item

    def projection(item, prefix, status=0):
        assert item['exit'] == 0 and demo.accepted_compose_stderr(item['stderr'], ROOT), item
        marker = prefix + ('turn_status=' + str(status) + ' ' if prefix == 'SAVED ' else '')
        lines = [line[len(marker):] for line in item['stdout'].splitlines() if line.startswith(marker)]
        assert len(lines) == 1 and lines[0].isascii(), item
        return json.loads(lines[0])

    def refuse(item, before):
        assert item['exit'] == 3 and item['stdout'].startswith('REFUSED '), item
        assert len(item['stdout'].splitlines()) == 1 and item['database'] == before, item

    def passed(label):
        result['passed'].append(label)
        record()
        print('PASS ' + label, flush=True)

    try:
        for name, requested_caps in [('roundtrip', (16, 16)), ('narrowed', (2, 5))]:
            database = evidence / name
            database.mkdir()
            initial = invoke(name + '-init', 'init', database)
            assert initial['exit'] == 0 and initial['stdout'] == demo.INITIALIZED, initial
            saved = invoke(name + '-save', 'save', database, text='tool:echo:hello')
            old = projection(saved, 'SAVED ')
            assert old['generation'] == 0 and old['history']['spent'] == 3, old
            before = saved['database']
            for label, kwargs in [('binding', {'binding': 'wrong'}), ('generation', {'generation': 1}),
                                  ('prior', {'save': 'wrong'}), ('duplicate', {'next_save': 'save1'}),
                                  ('exhausted', {'caps': (3, 3)})]:
                refuse(invoke(name + '-refuse-' + label, 'continue', database, text='recall', **kwargs), before)
            continued = invoke(name + '-continue', 'continue', database, caps=requested_caps, text='recall')
            new = projection(continued, 'SAVED ')
            wanted = deepcopy(old)
            wanted['generation'] = 1
            wanted['history']['events'] += [{'role': 'user', 'kind': 'input', 'name': '', 'text': 'recall'},
                                           {'role': 'assistant', 'kind': 'final', 'name': '', 'text': 'remembered: hello'}]
            wanted['history']['characters'] += len('recallremembered: hello')
            wanted['history']['spent'] = 4
            wanted['references'] += [{'operation': '', 'phase': ''}] * 2
            wanted['caps']['steps'] = min(16, requested_caps[1])
            wanted['caps']['turn_steps'] = min(3, requested_caps[0])
            assert new == wanted, (new, wanted)
            assert continued['stdout'].startswith('user: recall\nassistant: remembered: hello\n'), continued
            assert 'model: tool' not in continued['stdout'] and 'tool: echo:' not in continued['stdout'], continued
            shown = invoke(name + '-show', 'show', database, caps=(16, 16), save='save2')
            assert projection(shown, 'SHOW ') == new and shown['database'] == continued['database'], shown
            values, messages = demo.metadata(database)
            assert messages == 2 and [v['snapshot']['generation'] for v in values if 'snapshot' in v] == [1], values
            for label, verb, kwargs in [('old-show', 'show', {}), ('stale', 'continue', {'text': 'recall'}),
                                      ('second-successor', 'continue', {'save': 'save2', 'generation': 1, 'next_save': 'save3', 'text': 'recall'})]:
                refuse(invoke(name + '-' + label, verb, database, **kwargs), continued['database'])
            passed(name + '_three_process_history_caps_identity_no_replay_and_stale_refusals')
        result['sources_after'] = {name: demo.digest(ROOT / name) for name in hashes}
        assert result['sources_after'] == hashes
        result['status'] = 'passed'
        passed('retained_input_closure_unchanged')
    except BaseException:
        result['status'] = 'failed'
        record()
        raise


if __name__ == '__main__':
    main()
