#!/usr/bin/env python3
"""Pure lifecycle argument/help contracts; no Model, File or Memory execution."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import harness_checkpoint_contract_probe as checkpoint
from normal_graph_identity import bootstrap_evidence_paths, verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/cli002a/contract_probe.es'
MODULES = checkpoint.MODULES + ['cli/harness_checkpoint_args.es', 'cli/harness_successor_args.es', 'cli/session_lifecycle_args.es']
HELP = [
    'Nomo sessions: init -> new -> resume -> show.',
    'Run: etas run PROJECT --flow COMMAND --allow-effects --args OPTIONS. Commands select their existing profiles.',
    'init: --id ID --workspace BIND --allow FILE[,FILE]',
    'new: --id ID --workspace BIND --allow FILE[,FILE] --once TEXT',
    'resume: --id FIRST --successor SECOND --workspace BIND --allow FILE[,FILE] --once TEXT',
    'show first: --id FIRST --workspace BIND --allow FILE[,FILE]',
    'show successor: --id FIRST --successor SECOND --workspace BIND --allow FILE[,FILE]',
    'Help: use --flow help [--args COMMAND], or pass help/--help alone after --args for any command.',
    'Initialize one fresh private project-owned store. Keep IDs, workspace label and ordered allowed files explicit.',
    'Each first checkpoint admits at most one second turn; successors allow show only. No latest selection or third turn.',
    'Failed, pending or unknown work is not completed. Admission may be consumed; do not retry automatically.',
    'Show reads saved data with no model/File configuration, tool replay or Memory mutation.',
    'NEXT arrays contain a --flow entry followed by literal --args values; replace placeholders.',
    'Bounds: IDs/workspace and request at most 128 printable ASCII characters; allow one/two files of at most 48 characters, at most 97 raw characters.',
]
CHECKPOINT_COUNT = 'expected --id ID --workspace BIND --allow FILE[,FILE] and save --once TEXT'
SUCCESSOR_COUNT = 'expected --id OLD --successor NEW --workspace BIND --allow FILE[,FILE] and continue --once TEXT'
INVALID_ID = 'invalid checkpoint identity'
INVALID_QUESTION = 'question requires 1..128 printable ASCII chars, not only spaces'
encoded = checkpoint.encoded


def literal(value):
    if isinstance(value, str):
        parts = []
        for index, part in enumerate(value.split('\\')):
            if index:
                parts.append('slash()')
            parts.append(json.dumps(part, ensure_ascii=False))
        def balanced(start, stop):
            if stop-start == 1:
                return parts[start]
            middle = (start+stop)//2
            return '('+balanced(start, middle)+' + '+balanced(middle, stop)+')'
        return balanced(0, len(parts))
    if isinstance(value, list):
        return '['+', '.join(literal(item) for item in value)+']'
    return encoded(value)


def identity(id='', workspace='', allowed=None):
    return dict(id=id, workspace=workspace, allowed=[] if allowed is None else list(allowed))


def request(*, help=False, id='first', next='', workspace='binding', allowed=('docs/a.txt',), text='', shown=False):
    blank = identity()
    return dict(help=help, predecessor=blank if help else identity(id, workspace, allowed),
                successor=identity(next, workspace, allowed) if next else deepcopy(blank), request=text, successor_show=shown)


def arguments(action, *, id='first', next='second', workspace='binding', allow='docs/a.txt', text='literal request', shown=False):
    values = ['--id', id]
    if action == 'resume' or shown:
        values += ['--successor', next]
    values += ['--workspace', workspace, '--allow', allow]
    if action in ['new', 'resume']:
        values += ['--once', text]
    return values


def cases():
    values = []
    def add(label, action, args, expected=None, error=''):
        values.append(dict(label=label, action=action, args=args, accepted=not error,
                           expected=request(help=True) if expected is None else expected, error=error))
    add('exact_help_contract', '@help_lines', [])
    for action in ['init', 'new', 'resume', 'show', 'help']:
        for selector in ['help', '--help']:
            add(action+'_standalone_'+selector, action, [selector], request(help=True))
    add('native_help_without_args', 'help', [], request(help=True))
    add('help_rejects_selectors', 'help', arguments('init'), error='session help accepts no selectors')
    for topic in ['init', 'new', 'resume', 'show']:
        add('native_help_topic_'+topic, 'help', [topic], request(help=True, text=topic))
    add('native_help_unknown_topic', 'help', ['latest'], error='unsupported session help topic; use init, new, resume or show')
    for topic, lines in [('', HELP), ('init', [HELP[n] for n in [2, 8, 13, 12]]),
                         ('new', [HELP[n] for n in [3, 9, 10, 13, 12]]),
                         ('resume', [HELP[n] for n in [4, 9, 10, 13, 12]]),
                         ('show', [HELP[n] for n in [5, 6, 11, 13, 12]]),
                         ('latest', ['Unsupported session help topic; use init, new, resume or show.'])]:
        add('topic_lines_'+repr(topic), '@topic_lines', lines, request(help=True, text=topic))
    for action in ['latest', 'continue', '', 'NEW']:
        add('unsupported_'+repr(action), action, ['--help'], error='unsupported session action; use init, new, resume, show or help')
    for action in ['init', 'new', 'resume', 'show']:
        text = 'literal request' if action in ['new', 'resume'] else ''
        expected = request(next='second' if action == 'resume' else '', text=text)
        valid = arguments(action)
        add(action+'_ordinary', action, valid, expected)
        add(action+'_empty', action, [], error=SUCCESSOR_COUNT if action == 'resume' else CHECKPOINT_COUNT)
        add(action+'_odd_count', action, valid[:-1], error=SUCCESSOR_COUNT if action == 'resume' else CHECKPOINT_COUNT)
        add(action+'_extra_pair', action, valid+['--latest', 'yes'],
            error=SUCCESSOR_COUNT if action == 'resume' else 'unknown successor option' if action == 'show' else CHECKPOINT_COUNT)
        add(action+'_unknown_latest', action, ['--latest', *valid[1:]],
            error='unknown successor option' if action == 'resume' else 'unknown checkpoint option')
        duplicate = list(valid); duplicate[2] = '--id'
        add(action+'_duplicate_id', action, duplicate,
            error='duplicate successor option' if action == 'resume' else 'duplicate checkpoint option')
        for field in ['id', 'workspace']:
            add(action+'_'+field+'_128', action, arguments(action, **{field: 'x'*128}),
                request(next='second' if action == 'resume' else '', text=text, **{field: 'x'*128}))
            add(action+'_'+field+'_129', action, arguments(action, **{field: 'x'*129}), error=INVALID_ID)
        add(action+'_ordered_allow', action, arguments(action, allow='docs/b.txt,docs/a.txt'),
            request(next='second' if action == 'resume' else '', text=text, allowed=['docs/b.txt', 'docs/a.txt']))
    add('show_successor', 'show', arguments('show', shown=True), request(next='second', shown=True))
    add('show_successor_order', 'show', arguments('show', shown=True, allow='docs/b.txt,docs/a.txt'),
        request(next='second', allowed=['docs/b.txt', 'docs/a.txt'], shown=True))
    add('show_successor_same_id', 'show', arguments('show', shown=True, next='first'),
        error='successor must have a distinct checkpoint ID')
    add('resume_same_id', 'resume', arguments('resume', next='first'), error='successor must have a distinct checkpoint ID')
    add('show_literal_successor_id', 'show', arguments('show', id='--successor'), request(id='--successor'))
    add('new_literal_help', 'new', arguments('new', text='--help'), request(text='--help'))
    add('resume_literal_successor', 'resume', arguments('resume', text='--successor'), request(next='second', text='--successor'))
    add('init_literal_workspace_once', 'init', arguments('init', workspace='--once'), request(workspace='--once'))
    quoted = 'first "quoted" \\ tail'
    add('show_literal_quoted_identity', 'show', arguments('show', id=quoted), request(id=quoted))
    for action in ['new', 'resume']:
        for size in [128, 129]:
            add(action+'_request_'+str(size), action, arguments(action, text='x'*size),
                request(next='second' if action == 'resume' else '', text='x'*size), error=INVALID_QUESTION if size == 129 else '')
        for label, text in [('blank', '   '), ('newline', 'x\ny'), ('unicode', 'é')]:
            add(action+'_request_'+label, action, arguments(action, text=text), error=INVALID_QUESTION)
    for label, allow, error in [('three', 'a,b,c', 'expected one or two allowed files'),
                                ('duplicate', 'a,a', 'duplicate allowed file'),
                                ('parent', '../file', 'invalid allowed file'),
                                ('absolute', '/file', 'invalid allowed file'),
                                ('blank', '', 'invalid allowed file'),
                                ('file49', 'a'*49, 'invalid allowed file'),
                                ('raw98', 'a'*48+','+'b'*49, 'raw allowlist exceeds 97 characters')]:
        add('allow_'+label, 'init', arguments('init', allow=allow), error=error)
    add('allow_raw97', 'init', arguments('init', allow='a'*48+','+'b'*48), request(allowed=['a'*48, 'b'*48]))
    assert len(values) <= 100 and len(values) == len({value['label'] for value in values})
    return values


def typed_identity(value):
    return checkpoint.record('Identity', **{key: literal(value[key]) for key in ['id', 'workspace', 'allowed']})


def expression(value):
    wanted = value['expected']
    expected = checkpoint.record('Request', help=literal(wanted['help']), predecessor=typed_identity(wanted['predecessor']),
                                 successor=typed_identity(wanted['successor']), request=literal(wanted['request']),
                                 successor_show=literal(wanted['successor_show']))
    return checkpoint.record('Check', label=literal(value['label']), action=literal(value['action']), args=literal(value['args']),
                             accepted=literal(value['accepted']), expected=expected, error=literal(value['error']))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


MANIFEST = checkpoint.MANIFEST.replace('harness-checkpoint-contract-probe', 'session-lifecycle-contract-probe')
BATCH_SIZE = 16


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--etas', required=True, type=Path)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--prepare-only', action='store_true')
    options = parser.parse_args(); assert options.etas.is_absolute()
    cli = options.etas if options.prepare_only else verify_cli()
    assert options.prepare_only or cli.resolve() == options.etas.resolve()
    options.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='session-lifecycle-contract-', dir=options.evidence_dir))
    print('EVIDENCE '+str(evidence), flush=True)
    paths = [ROOT/'src/nomo'/name for name in MODULES] + [Path(__file__).resolve(), FIXTURE,
             ROOT/'tests/harness_checkpoint_contract_probe.py', ROOT/'tests/normal_graph_identity.py',
             *bootstrap_evidence_paths(), ROOT/'config/etas-latest-main.json', ROOT/'etas.lock']
    frozen = {str(path.relative_to(ROOT)): digest(path) for path in paths}
    for path in paths:
        target = evidence/'inputs'/path.relative_to(ROOT); target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target); assert digest(target) == frozen[str(path.relative_to(ROOT))]
    values = cases(); template = (evidence/'inputs'/FIXTURE.relative_to(ROOT)).read_text()
    assert template.count('__CHECKS__') == template.count('__HELP__') == 1
    result = dict(scope='pure lifecycle arguments/help; no Model/File/Memory execution', status='prepared' if options.prepare_only else 'running',
                  prepared_only=options.prepare_only, checks=[value['label'] for value in values], inputs=frozen,
                  case_matrix_sha256=hashlib.sha256(encoded(values).encode()).hexdigest(), commands=[], batches=[], observed_checks=[],
                  per_command_timeout_seconds=180, batch_size=BATCH_SIZE, root_lock_provenance_only=True)
    for index, offset in enumerate(range(0, len(values), BATCH_SIZE)):
        group = values[offset:offset+BATCH_SIZE]; directory = evidence/'batches'/f'{index:03d}'; project = directory/'project'
        for name in MODULES:
            target = project/'src/nomo'/name; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(evidence/'inputs/src/nomo'/name, target)
        source = project/'src/app/contract_probe.es'; source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(template.replace('__HELP__', literal(HELP)).replace('__CHECKS__', '['+',\n'.join(expression(value) for value in group)+']'))
        (project/'etas.toml').write_text(MANIFEST)
        result['batches'].append(dict(index=index, checks=[value['label'] for value in group], project=str(project.relative_to(evidence)),
                                     generated_source_sha256=digest(source), status='prepared' if options.prepare_only else 'not_run'))
    output = evidence/'results.json'
    def save(): output.write_text(json.dumps(result, indent=2)+'\n')
    save()
    if options.prepare_only: return
    result['identity'] = dict(executable=str(cli), sha256=digest(cli)); save()
    try:
        for batch in result['batches']:
            batch['status'] = 'running'; project = evidence/batch['project']; directory = project.parent; trace_path = directory/'trace.json'; save()
            for name, arguments in [('check', ['check', '--all', str(project)]),
                                    ('pure-effects', ['effects', str(project), '--flow', 'pure_probe']),
                                    ('observe', ['run', str(project), '--flow', 'observe', '--allow-effects', '--trace-out', str(trace_path)])]:
                assert {str(path.relative_to(ROOT)): digest(path) for path in paths} == frozen
                inputs = [project/'etas.toml', *sorted((project/'src').rglob('*.es'))]
                if (project/'etas.lock').exists(): inputs.append(project/'etas.lock')
                item = dict(label=f'batch-{batch["index"]:03d}-'+name, kind=name, status='running',
                            command=[str(cli), *arguments], project=batch['project'], inputs={str(path.relative_to(project)): digest(path) for path in inputs})
                result['commands'].append(item); save()
                try:
                    run = subprocess.run(item['command'], capture_output=True, timeout=180)
                except subprocess.TimeoutExpired as error:
                    for label, raw in [('stdout', error.stdout or b''), ('stderr', error.stderr or b'')]:
                        target = directory/(name+'.'+label+'.bin'); target.write_bytes(raw)
                        item[label+'_sha256'] = digest(target); item[label+'_retained'] = str(target.relative_to(evidence))
                    item.update(timeout=True, exit=None); save(); raise
                for label, raw in [('stdout', run.stdout), ('stderr', run.stderr)]:
                    target = directory/(name+'.'+label+'.bin'); target.write_bytes(raw)
                    item[label+'_sha256'] = digest(target); item[label+'_retained'] = str(target.relative_to(evidence))
                item.update(exit=run.returncode, timeout=False, stdout=run.stdout.decode(), stderr=run.stderr.decode()); save()
                assert run.returncode == 0 and not run.stderr, item
                assert all(digest(project/path) == checksum for path, checksum in item['inputs'].items())
                if name == 'pure-effects':
                    assert 'requested actions: []' in item['stdout'] and 'default actions: []' in item['stdout']
                if name == 'observe':
                    assert item['stdout'].splitlines() == ['PASS '+label for label in batch['checks']]
                    trace = json.loads(trace_path.read_text()); started = [value for value in trace['events'] if value['kind'] == 'host_request_started']
                    assert {value['qualified_action'] for value in started} <= {'Policy.evaluate', 'Console.stdout_write'}
                    assert sum(value['qualified_action'] == 'Console.stdout_write' for value in started) == len(batch['checks'])
                    batch.update(trace_sha256=digest(trace_path), trace_retained=str(trace_path.relative_to(evidence)))
                    result['observed_checks'].extend(line[len('PASS '):] for line in item['stdout'].splitlines())
                item['status'] = 'passed'; save()
            batch['status'] = 'passed'; save()
        assert result['observed_checks'] == result['checks'] and all(value['status'] == 'passed' for value in result['batches'])
        assert len(result['commands']) == 3*len(result['batches']) and digest(cli) == result['identity']['sha256']
        assert {str(path.relative_to(ROOT)): digest(path) for path in paths} == frozen
        result.update(status='passed', inputs_unchanged=True); save()
        print('PASS '+str(len(values))+' pure lifecycle checks; no Model/File/Memory execution', flush=True)
    except BaseException as error:
        if 'item' in locals() and item['status'] != 'passed': item['status'] = 'failed'
        if 'batch' in locals() and batch['status'] != 'passed': batch['status'] = 'failed'
        result.update(status='failed', failure=repr(error)); save(); raise


if __name__ == '__main__':
    main()
