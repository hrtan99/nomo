#!/usr/bin/env python3
"""Same existing Harness controller with deterministic source handlers; zero Model."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import resources
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/harness_handler001/controller_probe.es'
LABELS = ['direct child shares actual controller', 'complete tool outcome reaches aggregate',
          'compatible decoder remains explicit policy', 'invalid request precedes dispatch',
          'exhausted reservation precedes dispatch', 'bad plan retains attempted call',
          'untrusted child metadata stays unresolved', 'failed child never aggregates',
          'work still requires an actual tool return', 'invalid aggregate retains final call',
          'child controller resumes deterministic model', 'child input refuses before effect trap',
          'child exhausted reservation never dispatches', 'stopped child never replays',
          'summary controller preserves completed context', 'summary failure keeps completed truth and charge',
          'summary exhausted reservation precedes effect trap']


def sources():
    pending, found = ['nomo.harness.harness_model_tools', 'nomo.harness.legacy_string_stages', 'nomo.entry.harness_work_entry'], {}
    while pending:
        module = pending.pop()
        if module in found:
            continue
        path = (ROOT/'src').joinpath(*module.split('.')).with_suffix('.es')
        body = path.read_text()
        assert re.findall(r'^\s*module\s+([\w.]+)\s*;', body, re.M) == [module], path
        found[module] = path
        for imported in re.findall(r'^\s*(?:public\s+)?import\s+(nomo(?:\.[A-Za-z_]\w*)*)[.\s;]', body, re.M):
            parts = imported.split('.')
            selected = ['.'.join(parts[:end]) for end in range(2, len(parts)+1)
                        if (ROOT/'src').joinpath(*parts[:end]).with_suffix('.es').is_file()]
            assert len(selected) == 1, imported
            pending.append(selected[0])
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--remaining-only', action='store_true', help='Run only the7 child/summary groups; earlier10 retained separately')
    options = parser.parse_args()
    labels = LABELS[10:] if options.remaining_only else LABELS
    flow = 'observe_remaining' if options.remaining_only else 'observe'
    options.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='harness-handler001-', dir=options.evidence_dir)).resolve()
    project = evidence/'project'; (project/'src/app').mkdir(parents=True)
    copied = {}
    for source in sources().values():
        relative = source.relative_to(ROOT); target = project/relative
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target)
        copied[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
    shutil.copyfile(FIXTURE, project/'src/app/harness_handler_probe.es')
    manifest = MANIFEST.replace('harness-checkpoint-contract-probe', 'harness-handler001').replace('app.contract_probe', 'app.harness_handler_probe')
    (project/'etas.toml').write_text(manifest)
    result = dict(task='HARNESS-HANDLER-001', status='prepared', sources=copied,
                  fixture_sha256=hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), groups=labels, commands=[],
                  selection='remaining7 only; earlier10 not replayed or claimed by this result' if options.remaining_only else 'all17',
                  scope='Deterministic scoped handlers execute the same existing public run_context as Standard/Work/Chain production handlers.',
                  qualification='Synthetic child metadata is inspected/settled by the real controller. No actual File, typed-record backend, persisted work, confirmation or edit is proved.')
    output = evidence/'results.json'
    def save(): output.write_text(json.dumps(result, indent=2)+'\n')
    save(); print('EVIDENCE '+str(evidence), flush=True)
    if options.prepare_only:
        return 0
    try:
        cli = verify_cli(); trace = evidence/'observe.trace.json'
        commands = [('check', [cli, 'check', '--all', project]),
                    ('observe-effects', [cli, 'effects', project, '--flow', flow]),
                    ('observe', [cli, 'run', project, '--flow', flow, '--allow-effects', '--trace-out', trace])]
        for label, argv in commands:
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save()
            try:
                observed = subprocess.run(item['command'], capture_output=True, timeout=240)
                out, err = observed.stdout, observed.stderr
            except subprocess.TimeoutExpired as error:
                out, err = error.output or b'', error.stderr or b''
                (evidence/(label+'.stdout.bin')).write_bytes(out); (evidence/(label+'.stderr.bin')).write_bytes(err)
                item.update(timeout=True, stdout=out.decode(errors='replace'), stderr=err.decode(errors='replace')); save()
                raise
            (evidence/(label+'.stdout.bin')).write_bytes(out); (evidence/(label+'.stderr.bin')).write_bytes(err)
            item.update(exit=observed.returncode, stdout=out.decode(), stderr=err.decode()); save()
            assert observed.returncode == 0 and not err, (label, observed.returncode, str(evidence))
            if label == 'observe-effects':
                assert 'Console.stdout_write' in item['stdout'] and not any(name in item['stdout'] for name in ('Agentic.', 'Memory.', 'Approval.', 'Console.stdin')), item
            if label == 'observe':
                assert [line for line in item['stdout'].splitlines() if line.startswith('PASS ')] == ['PASS '+label for label in labels], item
        raw = json.loads(trace.read_text())
        starts = [event for event in raw['events'] if event['kind'] == 'host_request_started']
        finishes = [event for event in raw['events'] if event['kind'] == 'host_request_finished']
        actions = [event['qualified_action'] for event in starts]
        assert set(actions) <= {'Policy.evaluate', 'Console.stdout_write'}, actions
        assert {event['id'] for event in starts} == {event['id'] for event in finishes}
        assert raw['termination']['local_work_settled'] is True and raw['outcome']['kind'] == 'completed'
        result.update(status='passed', actual_host_actions=actions,
                      static_effect_qualification='The child controller retains its potential Fs.read branch in static effects. The fixture grants Console only; actual observed actions must still exclude File. No broader filesystem policy is installed.',
                      actual_actions=dict(Model=0, HTTP=0, File=0, Memory=0, Approval=0, atomic=0, admission=0))
    except BaseException as error:
        result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'], valid = resources()
        if not valid: result.update(status='failed', resource_failure='ordinary4GiB resource guard failed')
        save(); assert valid, result
    print('PASS '+str(len(labels))+' deterministic Handler groups; same controllers; zero Model/File/admission', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
