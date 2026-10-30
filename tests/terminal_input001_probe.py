#!/usr/bin/env python3
"""Eight focused actual-Console cases for TERMINAL_INPUT_001, root execution only.

prepare copies the real entry's import closure and one transparent wrapper into
a fresh owned project. controls checks source/effects and the explicit deny
profile without running an application flow. case executes only its selected
case, with literal invalid inputs, help/exit/EOF or invalid once arguments.
No Model/Command/Memory/File/Approval capability, provider, store or valid work
request is configured. This is direct entry/Console evidence, not launcher TTY,
native workflow, cancellation, durable balance or general terminal acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
CLI_SHA256 = '460f26bf3b1855b72581595cc0d85ac153312f32d9ed98e375e1beee8071d135'
PINS = {
    'cli': '2a57d709f9a352b26e59917b2e3fe4da761397f9',
    'core': '9da73aec66367f724e2870f7738b436edb0faad5',
    'frontend': '9bba251b2e584080cbc37d7f525ce786674e837a',
    'interpreter': '6baed226c66dea56a9f9b00a1bc4ba7a4ae49fe1',
}
PROFILE = 'terminal-input-denied'
CAP = '13,7,47104,196608,1,4096,3,6144,1,2048'
PROMPT = 'REQUEST /help /show /exit'
HELP_START = 'Nomo terminal: line-oriented wrapper around the existing two-turn work chain.'
HELP_END = 'Host: ./scripts/local-tryout.sh terminal-help; ./scripts/local-tryout.sh terminal PREPARED_DIRECTORY new|continue OPTIONS'
RECOVERY_HELP = 'Interactive malformed input prints its diagnostic and returns to the prompt, consuming one of the 32 raw input lines. Admitted work failures still stop.'
UNKNOWN = 'unknown terminal command; use /help, /show or /exit'
QUESTION = 'question requires 1..128 printable ASCII chars, not only spaces'
LIMIT = 'terminal input limit reached; inspect captured state; no further request in this process'
NEW = ['new', '--id', 'input-root', '--child-id', 'input-child', '--workspace',
       'terminal-input-fixture-v1', '--path', 'target.txt', '--allow', 'context.txt']
CONTINUE = ['continue', '--parent', 'input-root', '--id', 'input-child', '--workspace',
            'terminal-input-fixture-v1', '--path', 'target.txt', '--allow', 'context.txt']
CASES = {
    'unknown-help-exit-new': dict(flow='interactive', args=NEW, data=b'/unknown\n/help\n/exit\n',
        actions=[('error', UNKNOWN), ('help', ''), ('exit', '')], reads=3, returned=0, phase='first'),
    'unknown-help-exit-continue': dict(flow='interactive', args=CONTINUE, data=b'/unknown\n/help\n/exit\n',
        actions=[('error', UNKNOWN), ('help', ''), ('exit', '')], reads=3, returned=0, phase='second'),
    'blank-LF-CRLF-exit': dict(flow='interactive', args=NEW, data=b'\n\r\n/exit\n',
        actions=[('error', QUESTION), ('error', QUESTION), ('exit', '')], reads=3, returned=0, phase='first'),
    'oversize-control-exit': dict(flow='interactive', args=NEW, data=b'x' * 129 + b'\n\x1b[2J\n/exit\n',
        actions=[('error', 'terminal line exceeds 128 characters before trimming'),
                 ('error', 'expected printable ASCII terminal line'), ('exit', '')], reads=3, returned=0, phase='first'),
    'raw32-no33rd-read': dict(flow='interactive', args=NEW, data=b'/unknown\n' * 32 + b'/exit\n',
        actions=[('error', UNKNOWN)] * 32, reads=32, returned=1, phase='first', limit=True),
    'empty-raw-EOF': dict(flow='interactive', args=NEW, data=b'',
        actions=[('eof', '')], reads=1, returned=0, phase='first'),
    'once-missing': dict(flow='once', args=NEW, data=b'/unknown\n/help\n/exit\n',
        actions=[], reads=0, returned=1, startup_error='non-TTY terminal mode requires explicit --once REQUEST'),
    'once-empty': dict(flow='once', args=NEW + ['--once', ''], data=b'/unknown\n/help\n/exit\n',
        actions=[], reads=0, returned=1, startup_error=QUESTION),
}
MANIFEST = '''[package]
name = "terminal-input001-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "terminal-input-denied"
[runtime.profiles.terminal-input-denied]
boundary_policy = "terminal-input001-console-only"
[runtime.profiles.terminal-input-denied.policy]
mode = "local-static"
rules = ["console=allow", "model=deny", "memory=deny", "session=deny", "filesystem=deny", "command=deny", "approval=deny"]
[runtime.profiles.terminal-input-denied.approval]
mode = "deny"
[[bin]]
name = "interactive"
module = "app.terminal_input_probe"
flow = "interactive"
profile = "terminal-input-denied"
[[bin]]
name = "once"
module = "app.terminal_input_probe"
flow = "once"
profile = "terminal-input-denied"
'''
LOCK = 'version = 1\nmanifest_fingerprint = "etas-lock-input:v1|package=terminal-input001-probe|version=0.0.0|edition=2026"\npackage = []\n'


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def helpers(source):
    sys.path.insert(0, str(source / 'tests'))
    from normal_graph_identity import verify_cli
    from model_protocol_probe import resources
    return verify_cli, resources


def identity(source):
    config = json.loads((source / 'config/etas-latest-main.json').read_text())
    require(config['selector'] == 'latest' and
            {name: row['revision'] for name, row in config['repositories'].items()} == PINS,
            'Actual official010 configuration required')
    verify, resource = helpers(source)
    cli = verify()
    require(digest(cli) == CLI_SHA256, 'Actual selected010 binary differs')
    return cli, resource


def copy_closure(source, project):
    modules = {}
    for path in sorted((source / 'src').rglob('*.es')):
        match = re.search(r'^module\s+([\w.]+);', path.read_text(), re.M)
        if match:
            require(match[1] not in modules, 'Duplicate module: ' + match[1])
            modules[match[1]] = path
    pending = ['nomo.entry.terminal_entry', 'nomo.entry.terminal_help']
    selected = set()
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        require(name in modules, 'Missing source module: ' + name)
        selected.add(name)
        for target in re.findall(r'^(?:public\s+)?import\s+(nomo\.[\w.]+)', modules[name].read_text(), re.M):
            target = target.rstrip('.')
            choices = [item for item in modules if item == target or target.startswith(item + '.')]
            require(bool(choices), 'Unresolved import: ' + target)
            pending.append(max(choices, key=len))
    for name in sorted(selected):
        path = modules[name]
        target = project / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    return sorted(selected)


def fixture_snapshot(folder):
    rows = {}
    for root_name in ['readonly-inputs', 'unconfigured-store']:
        root = folder / root_name
        require(root.is_dir() and not root.is_symlink(), 'Owned fixture root changed')
        rows[root_name] = dict(kind='directory', mode=stat.S_IMODE(root.lstat().st_mode), owner=root.lstat().st_uid)
        for path in sorted(root.rglob('*')):
            require(not path.is_symlink(), 'Fixture acquired a symlink')
            if path.is_file():
                rows[str(path.relative_to(folder))] = dict(kind='file', sha256=digest(path), bytes=path.stat().st_size,
                    mode=stat.S_IMODE(path.lstat().st_mode), owner=path.lstat().st_uid)
            else:
                require(path.is_dir(), 'Unexpected fixture object')
                rows[str(path.relative_to(folder))] = dict(kind='directory', mode=stat.S_IMODE(path.lstat().st_mode), owner=path.lstat().st_uid)
    return rows


def package_inputs(folder):
    project = folder / 'project'
    paths = [*sorted((project / 'src').rglob('*.es')), project / 'etas.toml', project / 'etas.lock']
    return {str(path.relative_to(folder)): digest(path) for path in paths}


def source_inputs(source, project):
    relative = [str(path.relative_to(project)) for path in sorted((project / 'src/nomo').rglob('*.es'))]
    relative += ['tests/fixtures/terminal_input001/entry_probe.es', 'config/etas-latest-main.json',
                 'scripts/etas-latest-cli-bootstrap.py', 'tests/normal_graph_identity.py',
                 'tests/model_protocol_probe.py']
    return {name: digest(source / name) for name in relative}


def prepare(source, evidence_dir):
    evidence_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='terminal-input001-', dir=evidence_dir)).resolve()
    metadata = folder.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and stat.S_IMODE(metadata.st_mode) == 0o700
            and metadata.st_uid == os.getuid(), 'Fresh owned private evidence required')
    project = folder / 'project'
    (project / 'src/app').mkdir(parents=True)
    selected = copy_closure(source, project)
    shutil.copyfile(source / 'tests/fixtures/terminal_input001/entry_probe.es',
                    project / 'src/app/terminal_input_probe.es')
    (project / 'etas.toml').write_text(MANIFEST)
    (project / 'etas.lock').write_text(LOCK)
    (folder / 'readonly-inputs').mkdir(mode=0o700)
    (folder / 'unconfigured-store').mkdir(mode=0o700)
    for name, content in [('target.txt', b'original terminal input fixture\n'),
                          ('context.txt', b'context remains unused\n')]:
        path = folder / 'readonly-inputs' / name
        path.write_bytes(content)
        path.chmod(0o400)
    package = dict(schema='nomo.terminal-input001.package.v1', status='prepared',
        source_root=str(source), modules=selected, inputs=package_inputs(folder),
        source_inputs=source_inputs(source, project), driver_sha256=digest(Path(__file__)),
        fixture_before=fixture_snapshot(folder), case_names=list(CASES),
        expected_cli_sha256=CLI_SHA256, explicit_profile=PROFILE, selected_pins=PINS,
        qualification='Fresh explicit new/parent configuration, never --latest or /show. Input files are observation sentinels, not granted Fs regions; chmod is not claimed as mount isolation. Store is deliberately unconfigured. Host observer writes evidence; application business actions must all be zero.')
    save(folder / 'package.json', package)
    print('EVIDENCE ' + str(folder), flush=True)


def frozen(source, folder):
    package = json.loads((folder / 'package.json').read_text())
    require(package['schema'] == 'nomo.terminal-input001.package.v1' and
            package['driver_sha256'] == digest(Path(__file__)), 'Observer binding changed')
    require(package['inputs'] == package_inputs(folder), 'Prepared source/profile/lock changed')
    require(package['source_inputs'] == source_inputs(source, folder / 'project'), 'Bound source/helper changed')
    require(package['fixture_before'] == fixture_snapshot(folder), 'Unused fixture or store changed')
    require(package['case_names'] == list(CASES), 'Case inventory changed')
    return package


def environment():
    names = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CARGO_HOME', 'CARGO_TARGET_DIR']
    return {name: os.environ[name] for name in names if name in os.environ} | {
        'NOMO_NORMAL_GRAPH': 'latest', 'PYTHONDONTWRITEBYTECODE': '1',
        'ETAS_HOST_APPROVAL': 'deny', 'ETAS_HOST_MEMORY': 'none', 'ETAS_HOST_SESSION': 'none'}


def invoke(folder, label, command, *, data=b''):
    command = list(map(str, command))
    save(folder / (label + '.command.json'), command)
    (folder / (label + '.stdin.bin')).write_bytes(data)
    try:
        completed = subprocess.run(command, input=data, capture_output=True,
                                   timeout=120, env=environment())
    except subprocess.TimeoutExpired as error:
        (folder / (label + '.stdout.bin')).write_bytes(error.stdout or b'')
        (folder / (label + '.stderr.bin')).write_bytes(error.stderr or b'')
        raise
    (folder / (label + '.stdout.bin')).write_bytes(completed.stdout)
    (folder / (label + '.stderr.bin')).write_bytes(completed.stderr)
    row = dict(command=command, exit=completed.returncode,
               stdout=completed.stdout.decode(), stderr=completed.stderr.decode())
    save(folder / (label + '.result.json'), row)
    return row


def support(row):
    require(row['exit'] == 0 and row['stderr'] == '', row)
    values = re.findall(r'^\s*support: (.+)$', row['stdout'], re.M)
    require(len(values) == 1 and re.fullmatch(r'local|requires-host\[[^\]]+\]|requires-orchestration\[[^\]]+\]', values[0]), row)
    require(not any(name in values[0].lower() for name in ['rejected', 'unresolved', 'unknown']), row)


def controls(source, folder):
    frozen(source, folder)
    output = folder / 'controls.json'
    require(not output.exists(), 'Never overwrite an earlier control result')
    result = dict(status='running', commands=[], application_flow_executed=False)
    save(output, result)
    resource = None
    try:
        cli, resource = identity(source)
        project = folder / 'project'
        row = invoke(folder, 'check', [cli, 'check', '--all', project])
        result['commands'].append(row)
        require(row['exit'] == 0 and row['stderr'] == '' and
                row['stdout'] == 'checked ' + str(len(list((project / 'src').rglob('*.es')))) + ' files\n', row)
        for flow in ['interactive', 'once']:
            row = invoke(folder, flow + '-effects', [cli, 'effects', project, '--flow', flow])
            result['commands'].append(row)
            support(row)
        row = invoke(folder, 'profile', [cli, 'run', project, '--flow', 'interactive',
            '--profile', PROFILE, '--budget-time', '30s', '--print-runtime-profile'])
        result['commands'].append(row)
        require(row['exit'] == 0 and row['stderr'] == '', row)
        profile = json.loads(row['stdout'])
        require(profile['profile'] == PROFILE and profile['boundary_policy'] == 'terminal-input001-console-only', profile)
        require(profile['model'] is None and profile['tools'] == [] and
                profile['memory']['kind'] == profile['session']['kind'] == 'none', profile)
        require(profile['approval'] == 'Deny' and profile['policy_rules'] == 'local-static', profile)
        require(profile['filesystem_regions'] == [] and profile['command_programs'] == []
                and profile['command_isolation'] == 'denied', profile)
        require(profile['program_network_endpoints'] == profile['adapter_transport_endpoints'] == [], profile)
        require(profile['execution']['shutdown_grace_ms'] == 5000, profile)
        result['profile'] = profile
        frozen(source, folder)
        result.update(status='passed', application_business_actions=0,
                      qualification='check/effects/profile controls only; no fixture flow executed, no runtime zero-action or input recovery acceptance.')
    except BaseException as error:
        result.update(status='failed', failure=repr(error))
        raise
    finally:
        if resource is not None:
            try:
                result['resources'], valid = resource()
                if not valid:
                    result.update(status='failed', resource_failure=True)
            except BaseException as error:
                result.update(status='failed', resource_failure=repr(error))
        save(output, result)
    require(result['status'] == 'passed', result)
    print('PASS terminal-input001 controls; zero application flows', flush=True)


def trace(path):
    value = json.loads(path.read_text())
    require(isinstance(value, dict) and value['schema'] == 'etas.cli.interpreter-report.v1'
            and not value.get('incomplete', False), 'Incomplete/unrecognized report')
    require(value['outcome']['kind'] == 'completed' and
            value['termination']['local_work_settled'] is True, value)
    events = value['events']
    require(isinstance(events, list) and all(isinstance(row, dict) for row in events), value)
    starts = [row for row in events if row['kind'] == 'host_request_started']
    finishes = [row for row in events if row['kind'] == 'host_request_finished']
    start_ids = [row['id'] for row in starts]
    finish_ids = [row['id'] for row in finishes]
    require(len(start_ids) == len(set(start_ids)) and len(finish_ids) == len(set(finish_ids))
            and len(start_ids) == len(finish_ids) and set(start_ids) == set(finish_ids), 'Unpaired/duplicate Host IDs')
    allowed = ['Policy.evaluate', 'Console.stdout_write', 'Console.stdin_read_line']
    require(all(row['qualified_action'] in allowed for row in starts), starts)
    require(all(row['outcome']['kind'] == 'succeeded' for row in finishes), finishes)
    require(not any('storage' in row['kind'].lower() or 'approval' in row['kind'].lower() for row in events), events)
    require(all(not row.get('cleanup_errors') and not row.get('owner_lost', False)
                for row in value['termination']['operations']), value['termination'])
    return dict(complete=True, host_starts=len(starts), console_reads=sum(
        row['qualified_action'] == 'Console.stdin_read_line' for row in starts),
        application_Model=0, application_Command=0, application_Fs=0,
        application_Memory=0, application_Approval=0,
        qualification='Exact zero business Host starts only after completed, unique paired, settled report and exited CLI. No independent durable-ledger census is claimed.')


def expected_session(phase):
    second = phase == 'second'
    return dict(phase=phase, root_id='input-root', current_id='input-child' if second else 'input-root',
        turn='2' if second else '1', configured_turns_in_process='1' if second else '2',
        workspace='terminal-input-fixture-v1', path='target.txt', configured_cap=CAP,
        once='false', scope='configuration only; not a durable balance, File observation or permission')


def output_proof(text, spec):
    require(len(text.encode()) <= 32768 and all(character == '\n' or 32 <= ord(character) <= 126 for character in text),
            'Output must remain bounded printable ASCII plus LF')
    lines = text.splitlines()
    index = 0

    def take(expected):
        nonlocal index
        require(index < len(lines) and lines[index] == expected,
                dict(index=index, expected=expected, actual=lines[index:index + 1]))
        index += 1

    def error(expected):
        nonlocal index
        require(index < len(lines) and lines[index].startswith('ERROR '), lines[index:index + 1])
        require(json.loads(lines[index][6:]) == [expected], lines[index])
        index += 1

    if 'startup_error' in spec:
        error(spec['startup_error'])
    else:
        require(lines and lines[0].startswith('SESSION '), lines[:1])
        require(json.loads(lines[0][8:]) == expected_session(spec['phase']), lines[0])
        index += 1
        for kind, message in spec['actions']:
            take(PROMPT)
            if kind == 'error':
                error(message)
            elif kind == 'help':
                begin = index
                take(HELP_START)
                while index < len(lines) and lines[index] != PROMPT:
                    index += 1
                section = lines[begin:index]
                require(len(section) <= 40 and section[-1] == HELP_END and section.count(RECOVERY_HELP) == 1, section)
                require(not any(line.startswith(('ERROR ', 'SESSION {', 'TERMINAL_INPUT_RETURN ')) for line in section), section)
            elif kind == 'exit':
                take('STOP exit; captured state is preserved')
            elif kind == 'eof':
                take('STOP EOF; captured state is preserved')
            else:
                raise AssertionError('No work input is allowed in this fixture')
        if spec.get('limit', False):
            error(LIMIT)
    take('TERMINAL_INPUT_RETURN ' + str(spec['returned']))
    require(index == len(lines), dict(unexpected_output=lines[index:]))
    require(not any(line.startswith(('USER ', 'PREVIEW ', 'NOMO ', 'WORK ', 'APPROVAL ')) for line in lines), lines)
    return dict(returned=spec['returned'], session=expected_session(spec['phase']) if 'phase' in spec else None,
                prompts=len(spec['actions']), expected_console_reads=spec['reads'],
                source_derived_work_requests=0,
                qualification='SESSION verifies the initial configured state. Source preservation and absence of work/state transitions cover malformed-input recovery; no post-work balance/state claim.')


def single_case(source, folder, name):
    frozen(source, folder)
    require(json.loads((folder / 'controls.json').read_text())['status'] == 'passed', 'Controls must pass first')
    for prior in (folder / 'cases').glob('*/result.json'):
        require(json.loads(prior.read_text())['status'] == 'passed', 'Earlier failed case stops this prepared invocation')
    output = folder / 'cases' / name
    output.mkdir(parents=True, exist_ok=False)
    spec = CASES[name]
    result = dict(case=name, status='running', counts=None,
                  input_sha256=hashlib.sha256(spec['data']).hexdigest(), expected_reads=spec['reads'])
    save(output / 'result.json', result)
    resource = None
    try:
        cli, resource = identity(source)
        observed = invoke(output, 'console', [cli, 'run', folder / 'project', '--flow', spec['flow'],
            '--profile', PROFILE, '--allow-effects', '--budget-time', '30s',
            '--trace-out', output / 'trace.json', '--args', *spec['args']], data=spec['data'])
        result['CLI_exit'] = observed['exit']
        require(observed['exit'] == 0 and observed['stderr'] == '', observed)
        counts = trace(output / 'trace.json')
        require(counts['console_reads'] == spec['reads'], counts)
        result['counts'] = counts
        result['output_proof'] = output_proof(observed['stdout'], spec)
        frozen(source, folder)
        result['fixture_after'] = fixture_snapshot(folder)
        result.update(status='passed',
            qualification='Actual direct entry and Console only, transparent wrapper returns zero after printing actual entry status. No launcher/TTY, Model, work admission, native approval, journal/atomic/persistence or general terminal release acceptance.')
    except BaseException as error:
        result.update(status='failed', failure=repr(error))
        raise
    finally:
        try:
            result['fixture_after'] = fixture_snapshot(folder)
            require(result['fixture_after'] == json.loads((folder / 'package.json').read_text())['fixture_before'], 'Fixture/store changed')
        except BaseException as error:
            result.setdefault('collection_errors', []).append(dict(stage='fixture snapshot', error=repr(error)))
            result['status'] = 'failed'
        if resource is not None:
            try:
                result['resources'], valid = resource()
                if not valid:
                    result.update(status='failed', resource_failure=True)
            except BaseException as error:
                result.update(status='failed', resource_failure=repr(error))
        save(output / 'result.json', result)
    require(result['status'] == 'passed', result)
    print('PASS terminal-input001 ' + name, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['prepare', 'controls', 'case'], required=True)
    parser.add_argument('--source-root', type=Path, default=ROOT)
    parser.add_argument('--evidence-dir', type=Path)
    parser.add_argument('--folder', type=Path)
    parser.add_argument('--case', choices=list(CASES))
    options = parser.parse_args()
    if options.stage == 'prepare':
        require(options.evidence_dir is not None and options.folder is None and options.case is None, 'prepare arguments differ')
        prepare(options.source_root, options.evidence_dir)
    elif options.stage == 'controls':
        require(options.folder is not None and options.case is None and options.evidence_dir is None, 'controls arguments differ')
        controls(options.source_root, options.folder)
    else:
        require(options.folder is not None and options.case is not None and options.evidence_dir is None, 'case arguments differ')
        single_case(options.source_root, options.folder, options.case)


if __name__ == '__main__':
    main()
