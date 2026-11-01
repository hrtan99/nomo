#!/usr/bin/env python3
"""MODEL-TOOL-001 pure contracts and pre-adapter boundary checks on normal Etas."""
import hashlib
import io
import json
import os
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import traceback

from normal_graph_identity import bootstrap_path, selected_graph, verify_cli

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_result(directory, result):
    (directory / 'results.json').write_text(json.dumps(result, indent=2))


@contextmanager
def recording(directory, result):
    result.update(status='running', commands=[], passed=[])
    save_result(directory, result)
    try:
        yield
    except BaseException as error:
        result['status'] = 'failed'
        result['error'] = {'type': type(error).__name__, 'message': str(error),
                           'traceback': traceback.format_exc()}
        if result['commands']:
            result['commands'][-1].update(status='failed', error=result['error'])
        pending = result.pop('pending_group', None)
        if pending is not None:
            result['failed_group'] = pending['name']
        raise
    else:
        finish_group(result)
        if result['commands']:
            result['commands'][-1]['status'] = 'passed'
        result['status'] = 'passed'
    finally:
        save_result(directory, result)


def begin_command(directory, result, args):
    # A later command means the preceding synchronous outer assertions returned.
    finish_group(result)
    if result['commands']:
        result['commands'][-1]['status'] = 'passed'
    item = {'command': args, 'status': 'running'}
    result['commands'].append(item)
    save_result(directory, result)
    return item


def observed_command(directory, result, item, process):
    item.update(exit=process.returncode, stdout=process.stdout, stderr=process.stderr,
                status='awaiting_outer_assertions')
    save_result(directory, result)


def mark_group(directory, result, name):
    finish_group(result)
    result['pending_group'] = {'name': name, 'command': len(result['commands']) - 1}
    save_result(directory, result)


def finish_group(result):
    pending = result.pop('pending_group', None)
    if pending is not None:
        result['passed'].append(pending['name'])
        print('PASS ' + pending['name'], flush=True)


def main():
    directory = Path(tempfile.mkdtemp(prefix='model-tool-state-', dir=os.environ.get('NOMO_TEST_EVIDENCE', '/tmp')))
    print('EVIDENCE ' + str(directory), flush=True)
    result = {}
    with recording(directory, result):
        probe(directory, result)
    print('PASS model-tool pure/state cases ' + str(len(result['passed'])), flush=True)


def probe(directory, result):
    cli = verify_cli()
    identity = {'graph': selected_graph(), 'executable': str(cli), 'sha256': digest(cli)}
    cache_mount = next(line for line in Path('/proc/self/mountinfo').read_text().splitlines()
                       if line.split()[4] == '/home/nomo/.cargo')
    assert 'ro' in cache_mount.split()[5].split(',')
    shutil.copytree(ROOT / 'src', directory / 'src')
    fixture = ROOT / 'tests/fixtures/model_tool001_state.es'
    shutil.copyfile(fixture, directory / 'src/nomo/model_tool_test.es')
    shutil.copyfile(Path(__file__), directory / 'driver.py')
    shutil.copyfile(bootstrap_path(), directory / 'bootstrap.py')
    if selected_graph() in ('latest012', 'latest022'):
        shutil.copyfile(ROOT / 'scripts/etas-official-cli-common.py', directory / 'bootstrap-common.py')
        shutil.copyfile(ROOT / 'config/etas-official-legacy-bridge.json', directory / 'bootstrap-bridge.json')
    manifest = '''[package]
name = "nomo-model-tool-pure-test"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "pure"
[runtime.profiles.pure]
boundary_policy = "model-tool-pure-tests"
[runtime.profiles.pure.model]
adapter = "omlx-openai"
model = "Qwen3.5-9B-MLX-4bit"
base_url = "http://127.0.0.1:1/v1"
api_key_env = "MODEL_TOOL_PURE_TEST_KEY"
allow_private = true
enable_thinking = false
[runtime.profiles.pure.model.timeout]
request_deadline_ms = 500
connect_timeout_ms = 200
[runtime.profiles.pure.model.retry]
attempts = 1
delay_ms = 0
[runtime.profiles.pure.filesystem.regions."nomo.tools.workspace.ReadOnlyRoot"]
root = "/workspace/examples/model-tool001/workspace"
read = true
write = false
[runtime.profiles.pure.policy]
mode = "local-static"
rules = ["console=allow", "model=allow", "filesystem=allow"]
[runtime.profiles.pure.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "nomo.model_tool_test"
flow = "probe"
profile = "pure"
'''
    (directory / 'etas.toml').write_text(manifest)
    protected = {str(path.relative_to(ROOT)): digest(path) for path in (ROOT / 'src').rglob('*.es')}
    sources = {str(path.relative_to(directory)): digest(path) for path in (directory / 'src').rglob('*.es')}
    result.update(identity=identity, cache_mount=cache_mount, protected=protected, sources=sources,
                  fixture_sha256=digest(fixture), driver_sha256=digest(directory / 'driver.py'),
                  bootstrap_sha256=digest(directory / 'bootstrap.py'), manifest=manifest)
    save_result(directory, result)

    def run(arguments, flow='probe', command='run'):
        args = [str(cli), command, str(directory)]
        trace = directory / ('command-' + str(len(result['commands'])) + '.trace.json')
        if command == 'run':
            args += ['--flow', flow, '--allow-effects', '--trace-out', str(trace), '--args', *arguments]
        elif command == 'effects':
            args += ['--flow', flow]
        else:
            args += ['--all']
        item = begin_command(directory, result, args)
        process = subprocess.run(args, text=True, capture_output=True, timeout=60,
                                 env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1',
                                          MODEL_TOOL_PURE_TEST_KEY='synthetic-unused-no-model-expected'))
        if trace.exists():
            item['trace'] = {'path': str(trace.relative_to(directory)), 'sha256': digest(trace)}
        observed_command(directory, result, item, process)
        assert process.returncode == 0 and process.stderr == '', item
        if command == 'run':
            report = json.loads(trace.read_text())
            assert report['schema'] == 'etas.cli.interpreter-report.v1', report
            assert not report.get('incomplete', False) and report['termination']['local_work_settled'] is True, report
            requests = [event for event in report['events'] if event['kind'] == 'host_request_started']
            # Real Console output includes its Policy.evaluate Host request.
            assert all(event['qualified_action'] in ('Console.stdout_write', 'Policy.evaluate') for event in requests), requests
            finished = {event['id'] for event in report['events'] if event['kind'] == 'host_request_finished'}
            assert all(event['id'] in finished for event in requests), requests
        return process.stdout

    def passed(name):
        mark_group(directory, result, name)

    run([], command='check')
    effects = run([], command='effects')
    actions = next(line.strip() for line in effects.splitlines() if line.strip().startswith('requested actions:'))
    assert actions == 'requested actions: [Console.stdout_write]', actions
    passed('pure_protocol_has_console_test_output_only')
    path_effects = run([], command='effects', flow='pure_path')
    path_actions = next(line.strip() for line in path_effects.splitlines() if line.strip().startswith('requested actions:'))
    assert path_actions == 'requested actions: []', path_actions
    passed('shared_path_policy_has_no_effects')

    def decode(raw, expected=None, *, final_only=False, allowed='a.txt,b.txt'):
        output = run(['final_only' if final_only else 'decode', raw, allowed])
        if expected is None:
            assert output.startswith('ERR ') and len(output.splitlines()) == 1, output
        else:
            assert output.startswith('OK ') and json.loads(output[3:]) == expected, output

    def action(operation, files=(), literal='', text=''):
        return {'operation': operation, 'files': list(files), 'literal': literal, 'text': text}

    valid = [(['final', 'answer'], action('final', text='answer')),
             (['final', 'x' * 512], action('final', text='x' * 512)),
             (['final', '"' * 512], action('final', text='"' * 512)),
             (['final', '\\' * 512], action('final', text='\\' * 512)),
             (['final', '["read","a.txt"]'], action('final', text='["read","a.txt"]')),
             (['read', 'a.txt'], action('read', ['a.txt'])),
             (['search', '"\\', 'a.txt', 'b.txt'], action('search', ['a.txt', 'b.txt'], '"\\')),
             (['search', 'x' * 64, 'b.txt'], action('search', ['b.txt'], 'x' * 64))]
    for index, (fields, expected) in enumerate(valid):
        decode(json.dumps(fields, separators=(',', ':')), expected)
        passed('strict_decode_valid_' + str(index))
    decode('["final","ok"]' + ' ' * (1152 - len('["final","ok"]')), action('final', text='ok'))
    decode('["final","ok"]' + ' ' * (1153 - len('["final","ok"]')))
    decode('["read","a.txt"]' + ' ' * (384 - len('["read","a.txt"]')), action('read', ['a.txt']))
    decode('["read","a.txt"]' + ' ' * (385 - len('["read","a.txt"]')))
    passed('raw_reply_and_selected_tool_exact_bounds')
    malformed = ['', '[]', '["final"]', '["final","x","extra"]', '["read","a.txt","extra"]',
                 '["list","a.txt"]', '["command","a.txt"]', 'text', '{}', '[["final","x"]]',
                 '["final",0]', '["final",true]', '["final",null]', '["final",{}]',
                 '["final","x"] ["final","y"]', '["final","x",]', '[,"final","x"]',
                 '["final","x" "y"]', '["final","unterminated]', '["final","\\q"]',
                 '["final","\\n"]', '["final","\\u001b"]', '["final","\\u96ea"]',
                 '["final","雪"]', '["final","x"]\n', '[ "final",\t"x"]',
                 '["search","x","a.txt","b.txt","c.txt"]', '["search","","a.txt"]',
                 '["search","x","a.txt","a.txt"]', '["search","x","a.txt","outside.txt"]',
                 '["read","outside.txt"]', '["read","../a.txt"]', '["read","/a.txt"]',
                 json.dumps(['final', 'x' * 513]), json.dumps(['final', '   ']),
                 json.dumps(['search', 'x' * 65, 'a.txt'])]
    for index, raw in enumerate(malformed):
        decode(raw)
        passed('strict_decode_refused_' + str(index))
    decode('["final","ok"]', action('final', text='ok'), final_only=True)
    decode('["read","a.txt"]', final_only=True)
    decode('["search","x","a.txt"]', final_only=True)
    passed('second_response_final_only')

    for names, accepted in [('a.txt', True), ('a.txt,b.txt', True), ('x' * 48, True),
                            ('x' * 49, False), ('', False), ('a,a', False), ('a,b,c', False),
                            ('a,../b', False), ('a,/b', False), ('a,b/c/d', False)]:
        assert (run(['allowed', names]) == 'RESULT \n') == accepted, names
    for question, accepted in [('x', True), ('x' * 128, True), ('"\\' * 64, True),
                               ('x' * 129, False), ('', False), ('   ', False), ('x\n', False), ('雪', False)]:
        assert (run(['question', question]) == 'RESULT \n') == accepted, question
    passed('question_and_whole_allowlist_validation')
    assert run(['ledgers']) == 'LEDGERS_OK\n'
    assert run(['budgets']) == 'BUDGETS_OK\n'
    passed('independent_reservations_exact_limits_no_refund')

    names = ['a' * 48, 'b' * 48]
    def context(text):
        return {'history': [{'role': 'tool', 'kind': 'complete', 'name': 'search', 'text': text}],
                'allowed': names, 'final_only': True}
    overhead = len(json.dumps(context(''), separators=(',', ':')))
    for text, accepted in [('x' * (2048 - overhead), True), ('x' * (2049 - overhead), False),
                           ('"\\' * 450, True), ('"\\' * 512, False)]:
        output = run(['context', text, *names]).splitlines()
        encoded = output[0].removeprefix('JSON ')
        assert json.loads(encoded) == context(text)
        assert len(encoded) == len(json.dumps(context(text), separators=(',', ':')))
        assert (output[1] == 'RESULT ') == accepted, (len(encoded), output)
    passed('complete_context_exact2048_and_quote_backslash_expansion')

    for mode, text in [('steps', ''), ('calls', ''), ('tokens', ''), ('events', ''),
                       ('model-events', ''), ('content', 'x' * 1001), ('context', 'x' * 500)]:
        output = run([mode, text], flow='boundary')
        assert output.endswith('BOUNDARY_OK\n') and 'model:' not in output and 'tool:' not in output, output
        passed('pre_adapter_boundary_' + mode)
    assert {name: digest(ROOT / name) for name in protected} == protected
    assert {name: digest(directory / name) for name in sources} == sources
    passed('product_and_retained_fixture_hashes_unchanged')


def recorder_self_test():
    """Inject observer failures only; do not load Etas or invoke product code."""
    directory = Path(tempfile.mkdtemp(prefix='model-tool-pure-recorder-', dir=os.environ.get('NOMO_TEST_EVIDENCE', '/tmp')))
    shutil.copyfile(Path(__file__), directory / 'driver.py')
    checks = []
    for mode in ('after_command', 'after_group', 'before_command_returns', 'passed'):
        case = directory / mode
        case.mkdir()
        result = {'observer_only': True, 'injected_failure': mode != 'passed'}
        caught = None
        output = io.StringIO()
        try:
            with redirect_stdout(output), recording(case, result):
                item = begin_command(case, result, [sys.executable, '-c', 'print("observer-only output")'])
                running = json.loads((case / 'results.json').read_text())
                assert running['status'] == 'running' and running['commands'][-1]['status'] == 'running'
                if mode == 'before_command_returns':
                    raise RuntimeError('controlled observer dispatch exception')
                process = subprocess.run(item['command'], text=True, capture_output=True, timeout=5)
                observed_command(case, result, item, process)
                assert process.returncode == 0 and process.stdout == 'observer-only output\n'
                if mode in ('after_group', 'passed'):
                    mark_group(case, result, 'controlled_group')
                if mode != 'passed':
                    raise AssertionError('controlled observer outer assertion')
        except (AssertionError, RuntimeError) as error:
            caught = error
        (case / 'stdout.txt').write_text(output.getvalue())
        retained = json.loads((case / 'results.json').read_text())
        expected = 'passed' if mode == 'passed' else 'failed'
        assert retained['status'] == expected and retained['commands'][-1]['status'] == expected
        if mode == 'passed':
            assert caught is None and retained['passed'] == ['controlled_group'] and 'error' not in retained
            assert output.getvalue() == 'PASS controlled_group\n'
        else:
            assert caught is not None and retained['error']['message'].startswith('controlled observer')
            assert retained['commands'][-1]['error'] == retained['error'] and retained['passed'] == []
            assert 'PASS ' not in output.getvalue()
        checks.append({'mode': mode, 'passed': True, 'result': str((case / 'results.json').relative_to(directory)),
                       'sha256': digest(case / 'results.json')})
    summary = {'status': 'passed', 'observer_only': True, 'driver_sha256': digest(directory / 'driver.py'), 'checks': checks}
    (directory / 'self-test.json').write_text(json.dumps(summary, indent=2))
    print('PASS observer-only recorder self-test ' + str(directory), flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--recorder-self-test']:
        recorder_self_test()
    else:
        assert not sys.argv[1:], 'only --recorder-self-test is supported'
        main()
