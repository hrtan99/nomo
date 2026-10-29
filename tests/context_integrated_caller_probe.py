#!/usr/bin/env python3
"""Integrated E7/closed-Context caller package; source preparation only.

Uses the accepted scoped-handler controller and unchanged original caller fixture.
The original legal 14-source alias qualification remains separate; this closure
adds E7 pure contract dependencies without changing runtime grants or oracles.
Stages remain prepare, controls, negative and one externally reserved runtime.
This driver has not been imported, executed or tested; parent owns the actual lane.
"""
import argparse
import base64
from copy import deepcopy
import hashlib
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

from harness_checkpoint_contract_probe import source_literal
from model_protocol_probe import resources
from normal_graph_identity import verify_cli
from terminal002_native_probe import TrackedHTTPServer

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/context_preflight001/caller_probe.es'
MODULES = [
    'agent/model_tool.es',
    'agent/loop.es',
    'model/stub.es',
    'core/text.es',
    'core/conversation.es',
    'model/model_tool_contract.es',
    'model/tool_context.es',
    'context/preflight.es',
    'context/selection.es',
    'tools/path_policy.es',
    'tools/workspace.es',
    'tools/edit_encoding.es',
    'harness/model_plan_diagnostic.es',
    'harness/harness_edit_contract.es',
    'harness/harness_model_contract.es',
    'harness/harness_tool_contract.es',
    'harness/harness_work_contract.es',
    'harness/legacy_string_stages.es',
    'session/edit_operation.es',
    'tools/edit_proposal.es',
]
TOKEN = 'context-caller-synthetic-unused-outside-local-fixture'
PORT = 18936
QUESTION = 'Return a final answer'
ANSWER = 'CONTEXT_CALLER_OK'
REFUSAL = 'required model context exceeds 2048 encoded UTF-8 bytes'
ALLOW = ['docs/a.txt']
PROFILE_RULES = ['console=allow', 'model=allow', 'filesystem=deny', 'memory=deny',
                 'session=deny', 'approval=deny', 'command=deny']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def wire(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def event(role, kind, name, text):
    return dict(role=role, kind=kind, name=name, text=text)


def previous(events, spent=0, calls=0, tokens=0):
    return dict(history=dict(events=events, characters=sum(len(item['name']) + len(item['text']) for item in events),
                             spent=spent, stopped=False), calls=calls, tokens=tokens, tools=0, scan=0)


def record(name, fields):
    return name + ' { ' + ', '.join(key + ' = ' + source_literal(value) for key, value in fields.items()) + ' }'


def session_source(value):
    history = value['history']
    events = '[' + ', '.join(record('Event', item) for item in history['events']) + ']'
    state = ('State { events = ' + events + ', characters = ' + str(history['characters']) +
             ', spent = ' + str(history['spent']) + ', stopped = false }')
    return ('Session { history = ' + state + ', calls = ' + str(value['calls']) + ', tokens = ' +
            str(value['tokens']) + ', tools = ' + str(value['tools']) + ', scan = ' + str(value['scan']) + ' }')


def context_source(value):
    return ('Context { history = [' + ', '.join(record('Event', item) for item in value['history']) +
            '], allowed = ' + source_literal(value['allowed']) + ', final_only = false }')


def facts():
    pinned = event('user', 'context', 'original', 'Pinned original request')
    large_optional = event('model', 'text', 'qwen', 'x' * 1900)
    current = event('user', 'input', '', QUESTION)
    success_seed = previous([pinned, large_optional])
    selected = dict(history=[pinned, current], allowed=ALLOW, final_only=False)
    success_events = success_seed['history']['events'] + [current, event('model', 'text', 'qwen', ''),
                                                       event('assistant', 'final', '', ANSWER)]
    success = dict(state=previous(success_events, spent=1, calls=1, tokens=2048), status=0)
    required = event('user', 'context', 'parent', '雪' * 700)
    negative_seed = previous([required])
    negative_context = dict(history=[required, current], allowed=ALLOW, final_only=False)
    negative = dict(state=previous([required, current, event('error', 'error', '', REFUSAL)]), status=4)
    full = dict(history=success_seed['history']['events'] + [current], allowed=ALLOW, final_only=False)
    assert len(wire(full).encode()) > 2048 and len(wire(selected).encode()) <= 2048
    assert len(wire(negative_context)) <= 2048 < len(wire(negative_context).encode())
    return dict(success_seed=success_seed, negative_seed=negative_seed, selected=selected,
                success=success, negative=negative, negative_context=negative_context)


def manifest(model):
    profiles = []
    for name, model_allowed in [('caller', True), ('no-model', False)]:
        rules = PROFILE_RULES if model_allowed else [item.replace('model=allow', 'model=deny') for item in PROFILE_RULES]
        profiles.append(f'''[runtime.profiles.{name}]
boundary_policy = "context-caller-no-product-tools"
[runtime.profiles.{name}.model]
adapter = "omlx-openai"
model = {json.dumps(model)}
base_url = "http://127.0.0.1:{PORT}/v1"
api_key_env = "CONTEXT_CALLER_API_KEY"
allow_private = true
enable_thinking = false
[runtime.profiles.{name}.model.timeout]
request_deadline_ms = 5000
connect_timeout_ms = 1000
[runtime.profiles.{name}.model.retry]
attempts = 1
delay_ms = 0
[runtime.profiles.{name}.policy]
mode = "local-static"
rules = {json.dumps(rules)}
[runtime.profiles.{name}.approval]
mode = "deny"
''')
    return ('''[package]
name = "context-caller-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "no-model"
''' + '\n'.join(profiles) + '''[[bin]]
name = "probe"
module = "app.context_caller_probe"
flow = "negative"
profile = "no-model"
''')


def inputs(project):
    return {str(path.relative_to(project)): digest(path) for path in sorted((project / 'src').rglob('*.es'))} | {'etas.toml': digest(project / 'etas.toml')}


def prepare(parent):
    import tomllib
    folder = Path(tempfile.mkdtemp(prefix='context-caller-', dir=parent)).resolve()
    project = folder / 'project'
    (project / 'src/app').mkdir(parents=True)
    for name in MODULES:
        target = project / 'src/nomo' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'src/nomo' / name, target)
    data = facts()
    source = FIXTURE.read_text()
    replacements = dict(QUESTION=source_literal(QUESTION), SUCCESS_PREVIOUS=session_source(data['success_seed']),
                        NEGATIVE_PREVIOUS=session_source(data['negative_seed']),
                        SUCCESS_EXPECTED='LoopTurn { state = ' + session_source(data['success']['state']) + ', status = 0 }',
                        NEGATIVE_EXPECTED='LoopTurn { state = ' + session_source(data['negative']['state']) + ', status = 4 }',
                        NEGATIVE_CONTEXT=context_source(data['negative_context']))
    for key, value in replacements.items():
        assert '__' + key + '__' in source
        source = source.replace('__' + key + '__', value)
    assert not re.search(r'__[A-Z_]+__', source)
    (project / 'src/app/context_caller_probe.es').write_text(source)
    model = tomllib.loads((ROOT / 'etas.toml').read_text())['runtime']['profiles']['gateway-qwen']['model']['model']
    (project / 'etas.toml').write_text(manifest(model))
    save(folder / 'preparation.json', dict(status='prepared', inputs=inputs(project), expected=data, model=model,
         fixture_sha256=digest(FIXTURE), driver_sha256=digest(Path(__file__)), tracked_HTTP_sha256=digest(ROOT / 'tests/terminal002_native_probe.py'),
         execution=dict(Model=0, HTTP=0, Fs=0, Memory=0, Approval=0, Command=0, atomic=0),
         hard_bounds=dict(positive_calls=1, positive_tokens=2048, negative_calls=0, negative_tokens=0, HTTP_attempts_per_request=1, native_String_output_repair=False),
         qualification='Real public old run_loop; one optional event omitted only from Model Context, complete state retained. Numeric observer reports are not generic preflight capacity evidence. Original generic23/387 remains open; original14 qualification is separate from this integrated E7 package. Parent must reserve and approve actual runtime; no ledger mutation or automatic retry here.'))
    print('EVIDENCE ' + str(folder), flush=True)


def environment():
    # Do not inherit an unrelated Host backend, policy, tool or real-key override.
    base = {name: value for name, value in os.environ.items() if not name.startswith('ETAS_HOST_')}
    return dict(base, CONTEXT_CALLER_API_KEY=TOKEN, ETAS_HOST_MODEL_API_KEY=TOKEN,
                ETAS_HOST_MODEL_BASE_URL='http://127.0.0.1:' + str(PORT) + '/v1',
                ETAS_HOST_FILESYSTEM='none', ETAS_HOST_MEMORY='none', ETAS_HOST_SESSION='none', ETAS_HOST_APPROVAL='deny',
                ETAS_HOST_MODEL_RETRY_ATTEMPTS='1', ETAS_HOST_MODEL_RETRY_DELAY_MS='0',
                ETAS_HOST_MODEL_REQUEST_DEADLINE_MS='5000', ETAS_HOST_MODEL_CONNECT_TIMEOUT_MS='1000')


def run(folder, label, argv):
    command = list(map(str, argv))
    save(folder / (label + '.command.json'), command)
    try:
        process = subprocess.run(command, capture_output=True, timeout=30, env=environment(), input=b'')
    except subprocess.TimeoutExpired as error:
        (folder / (label + '.stdout.bin')).write_bytes(error.stdout or b'')
        (folder / (label + '.stderr.bin')).write_bytes(error.stderr or b'')
        raise
    (folder / (label + '.stdout.bin')).write_bytes(process.stdout)
    (folder / (label + '.stderr.bin')).write_bytes(process.stderr)
    item = dict(command=command, exit=process.returncode, stdout=process.stdout.decode(), stderr=process.stderr.decode())
    assert process.returncode == 0 and not process.stderr, item
    return item


def frozen(folder):
    preparation = json.loads((folder / 'preparation.json').read_text())
    assert inputs(folder / 'project') == preparation['inputs'], 'frozen caller inputs changed'
    assert digest(Path(__file__)) == preparation['driver_sha256'], 'driver changed after preparation'
    assert digest(ROOT / 'tests/terminal002_native_probe.py') == preparation['tracked_HTTP_sha256'], 'accepted HTTP tracker changed'
    return preparation


def controls(folder):
    preparation = frozen(folder)
    cli = verify_cli()
    project = folder / 'project'
    commands = [run(folder, 'check', [cli, 'check', '--all', project])]
    assert commands[0]['stdout'] == 'checked ' + str(len(MODULES) + 1) + ' files\n'
    for flow in ['success', 'negative']:
        item = run(folder, flow + '-effects', [cli, 'effects', project, '--flow', flow])
        assert 'rejected' not in item['stdout'].lower() and 'UnresolvedEffect' not in item['stdout'], item
        for name in ['requested actions', 'default actions']:
            action_row = re.findall(r'^\s*' + name + r': (.+)$', item['stdout'], re.M)
            assert len(action_row) == 1 and 'Console.stdout_write' in action_row[0] and 'ToolModel' in action_row[0] and 'Fs.read' in action_row[0], item
            assert not any(value in action_row[0] for value in ['Memory.', 'Approval.', 'Command.', 'atomic_replace', 'Console.stdin', 'ReadFirst', 'ReadFinal']), item
        commands.append(item)
    profiles = {}
    for profile, flow in [('caller', 'success'), ('no-model', 'negative')]:
        item = run(folder, profile + '-profile', [cli, 'run', project, '--flow', flow, '--profile', profile, '--print-runtime-profile'])
        value = json.loads(item['stdout'])
        assert value['approval'] == 'Deny', value
        assert value['model']['model'] == preparation['model'], value
        assert value['policy'] == 'LocalStatic' and value['filesystem'] == 'None' and value['filesystem_regions'] == [], value
        assert value['memory'] == dict(kind='none') and value['session']['kind'] == 'none', value
        assert value['command_programs'] == [] and value['command_isolation'] == 'denied', value
        assert value['model']['retry'] == dict(attempts=1, delay_ms=0), value
        assert value['model']['timeout'] == dict(request_deadline_ms=5000, connect_timeout_ms=1000), value
        assert value.get('tools', []) == [], value
        profiles[profile] = value
        commands.append(item)
    frozen(folder)
    resource, valid = resources()
    assert valid, resource
    save(folder / 'controls.json', dict(status='passed', commands=commands, profiles=profiles, resources=resource,
         inputs=preparation['inputs'], actual_Model=0, actual_HTTP=0,
         policy='Only Console/Model allowed for caller; no-model profile also denies Model. Fs.read is latent in unchanged public controller but denied by policy and must have zero actual trace starts. No Fs region/Memory/tool capability is granted.',
         qualification='Static/effective controls only; parent/TL review and external reservation precede runtime. Effective profile omits endpoint/rule details: manifest and explicit synthetic loopback env retain them; actual HTTP validates endpoint/body. Positive limits calls1/tokens2048; negative calls0/tokens0 plus Model-deny profile, so specific UTF8 refusal proves ordering under exhausted backstop budgets.'))
    print('PASS caller controls; zero Model/HTTP', flush=True)


def model_action(action):
    return action == 'Model.infer' or action.startswith('Agentic.infer')


def trace_facts(path):
    report = json.loads(path.read_text())
    assert report['schema'] == 'etas.cli.interpreter-report.v1' and not report.get('incomplete', False), report
    assert report['outcome']['kind'] == 'completed' and report['termination']['local_work_settled'] is True, report
    starts = [event for event in report['events'] if event['kind'] == 'host_request_started']
    finishes = [event for event in report['events'] if event['kind'] == 'host_request_finished']
    start_ids = [event['id'] for event in starts]
    finish_ids = [event['id'] for event in finishes]
    assert len(start_ids) == len(set(start_ids)) and len(finish_ids) == len(set(finish_ids)), report
    assert len(starts) == len(finishes) and set(start_ids) == set(finish_ids), report
    finished = {event['id']: event for event in finishes}
    assert all(finished[event['id']]['outcome']['kind'] == 'succeeded' for event in starts), report
    actions = [event['qualified_action'] for event in starts]
    assert all(action in ['Policy.evaluate', 'Console.stdout_write'] or model_action(action) for action in actions), actions
    return dict(actions=actions, native_model_starts=sum(map(model_action, actions)), complete=True)


def typed_report(item, expected):
    lines = [line[6:] for line in item['stdout'].splitlines() if line.startswith('PROBE ')]
    assert len(lines) == 1 and json.loads(lines[0]) == expected, item


def negative(folder):
    preparation = frozen(folder)
    assert json.loads((folder / 'controls.json').read_text())['status'] == 'passed'
    output = folder / 'negative.json'
    assert not output.exists(), 'no automatic negative replay'
    result = dict(status='running', Model=0, HTTP=0)
    save(output, result)
    error = None
    try:
        cli = verify_cli()
        item = run(folder, 'negative-run', [cli, 'run', folder / 'project', '--flow', 'negative', '--profile', 'no-model',
                                          '--budget-time', '20s', '--allow-effects', '--trace-out', folder / 'negative.trace.json'])
        typed_report(item, preparation['expected']['negative'])
        trace = trace_facts(folder / 'negative.trace.json')
        assert trace['native_model_starts'] == 0 and 'CONTEXT omitted ' not in item['stdout'], trace
        assert 'error: ' + REFUSAL in item['stdout'], item
        result.update(status='passed', trace=trace, typed_result=preparation['expected']['negative'],
                      qualification='Actual public run_loop produced the specific required2048UTF8 refusal before budget_error with calls0/tokens0 and Model-deny hard backstops; no fresh-available-budget negative claim. No HTTP server started. Whole typed result equality asserted in source.')
    except BaseException as failure:
        error = failure
        result.update(status='failed', failure=repr(failure), original_failure=repr(failure))
        raise
    finally:
        collection_error = None
        try:
            result['resources'], valid = resources()
        except BaseException as failure:
            collection_error = failure
            valid = False
            result.update(status='failed', resources=None, resource_failure=True,
                          final_observer_outcome='unknown')
            result.setdefault('failure', repr(error or failure))
            result.setdefault('collection_errors', []).append(dict(stage='resources', error=repr(failure)))
        if not valid:
            result.update(status='failed', resource_failure=True)
        try:
            save(output, result)
        except BaseException:
            if error is None and collection_error is None:
                raise
        # A collector failure must not replace the already-pending caller error.
        if error is None:
            if collection_error is not None:
                raise collection_error
            assert valid, result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, status, value):
        data = wire(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        item = dict(path=self.path, finished=threading.Event(), error=None)
        with self.server.record_lock:
            ordinal = len(self.server.records)
            self.server.records.append(item)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            assert self.path == '/v1/chat/completions' and 0 < length <= 16384
            raw = self.rfile.read(length)
            with self.server.record_lock:
                item['request_base64'] = base64.b64encode(raw).decode()
            assert len(raw) == length
            request = json.loads(raw)
            with self.server.record_lock:
                item['request'] = request
            assert ordinal == 0, 'unexpected extra HTTP request; never supply another valid response'
            assert self.headers.get('Authorization') == 'Bearer ' + TOKEN
            assert request['model'] == self.server.preparation['model'] and request['max_tokens'] == 2048
            assert not any(key in request for key in ['response_format', 'tools', 'tool_choice']), request
            assert request['chat_template_kwargs'] == dict(enable_thinking=False), request
            assert [message['role'] for message in request['messages']] == ['system', 'user'], request
            content = request['messages'][1]['content']
            expected = self.server.preparation['expected']['selected']
            assert content == wire(expected) and len(content.encode()) <= 2048, content
            assert json.loads(content) == expected
            response = dict(choices=[dict(message=dict(role='assistant', content=wire(['final', ANSWER])), finish_reason='stop')],
                            usage=dict(prompt_tokens=10, completion_tokens=4, total_tokens=14))
            with self.server.record_lock:
                item['response'] = response
            self.send_json(200, response)
        except BaseException as error:
            with self.server.record_lock:
                item['error'] = repr(error)
            try:
                self.send_json(500, dict(error=dict(message='context caller fixture refused unexpected request')))
            except OSError:
                pass
        finally:
            with self.server.record_lock:
                item['finished'].set()


class Server(TrackedHTTPServer):
    def __init__(self, preparation):
        super().__init__(('127.0.0.1', PORT))
        self.RequestHandlerClass = Handler
        self.preparation = preparation
        self.record_lock = threading.Lock()
        self.records = []


def stop_server(server, listener):
    shutdown = threading.Thread(target=server.shutdown, daemon=True)
    shutdown.start()
    shutdown.join(timeout=2)
    if listener.ident is not None:
        listener.join(timeout=2)
    settled = server.joined(time.monotonic() + 2)
    if not settled:
        server.abort_sockets()
        settled = server.joined(time.monotonic() + 2)
    server.server_close()
    with server.handler_lock:
        handlers = [dict(done=item['done'].is_set(), alive=item['thread'].is_alive(), errors=list(item['errors'])) for item in server.handlers]
    transport_settled = not shutdown.is_alive() and not listener.is_alive() and settled
    with server.record_lock:
        finished = all(item['finished'].is_set() for item in server.records)
        stable = transport_settled and finished and len(handlers) == len(server.records)
        if stable:
            records = deepcopy([dict({key: value for key, value in item.items() if key != 'finished'},
                                     finished=item['finished'].is_set()) for item in server.records])
        else:
            # Never publish a shallow/live request or response on uncertainty.
            # These fresh immutable-value summaries establish arrivals only.
            records = [dict(path=item['path'], finished=item['finished'].is_set(), payload_omitted=True)
                       for item in server.records]
    return dict(stable=stable, handlers=handlers, listener_done=not listener.is_alive(),
                shutdown_done=not shutdown.is_alive(), all_finished=finished), records


def runtime(folder, reservation):
    preparation = frozen(folder)
    assert json.loads((folder / 'controls.json').read_text())['status'] == 'passed'
    assert json.loads((folder / 'negative.json').read_text())['status'] == 'passed'
    output = folder / 'runtime.json'
    assert not output.exists(), 'one actual attempt only; no automatic retry'
    result = dict(status='running', parent_reservation=reservation, logical_exact=None, native_exact=None, HTTP_exact=None,
                  lower_bounds=dict(native=0, HTTP=0), qualification='One expected local scripted String inference through integrated E7 public run_loop; not Qwen/new typed E/B/work lifetime acceptance. Parent owns shared reservation; failure does not refund it.')
    save(output, result)
    server = listener = None
    error = None
    try:
        cli = verify_cli()
        server = Server(preparation)
        listener = threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=0.01), daemon=True)
        listener.start()
        result['command'] = run(folder, 'runtime-run', [cli, 'run', folder / 'project', '--flow', 'success', '--profile', 'caller',
                               '--budget-time', '20s', '--allow-effects', '--trace-out', folder / 'runtime.trace.json'])
    except BaseException as failure:
        error = failure
        result['original_failure'] = repr(failure)
    finally:
        if server is not None and listener is not None:
            try:
                result['HTTP_observer'], result['HTTP'] = stop_server(server, listener)
                result['lower_bounds']['HTTP'] = len(result['HTTP'])
                save(folder / 'HTTP.json', result['HTTP'])
            except BaseException as cleanup_error:
                result['HTTP_observer'] = dict(stable=False, error=repr(cleanup_error))
                error = error or cleanup_error
        else:
            result['HTTP_observer'] = dict(stable=False, reason='listener did not start')
        partial = folder / 'runtime.trace.json'
        try:
            if partial.exists():
                raw_trace = json.loads(partial.read_text())
                observed_starts = set()
                for item in raw_trace.get('events', []):
                    if item['kind'] == 'host_request_started' and model_action(item.get('qualified_action', '')):
                        observed_starts.add(item['id'])
                        result['lower_bounds']['native'] = max(result['lower_bounds']['native'], len(observed_starts))
        except BaseException as failure:
            result.update(partial_trace_unreadable=True, final_observer_outcome='unknown')
            result.setdefault('collection_errors', []).append(dict(stage='partial trace', error=repr(failure)))
            error = error or failure
        # One HTTP attempt per native request makes arrivals a qualified native
        # lower bound; it does not establish an exact logical-inference count.
        result['lower_bounds']['native'] = max(result['lower_bounds']['native'], result['lower_bounds']['HTTP'])
        try:
            if error is not None:
                raise error
            assert result['HTTP_observer']['stable'], result['HTTP_observer']
            trace = trace_facts(folder / 'runtime.trace.json')
            result['trace'] = trace
            result['lower_bounds']['native'] = max(result['lower_bounds']['native'], trace['native_model_starts'])
            assert trace['native_model_starts'] == 1 and len(result['HTTP']) == 1
            assert not result['HTTP'][0]['error']
            typed_report(result['command'], preparation['expected']['success'])
            assert result['command']['stdout'].count('CONTEXT omitted 1 optional history events; required facts retained.') == 1
            assert TOKEN not in result['command']['stdout'] + result['command']['stderr']
            frozen(folder)
            result.update(status='passed', logical_exact=1, native_exact=1, HTTP_exact=1,
                          typed_result=preparation['expected']['success'], expected_selected_Context=preparation['expected']['selected'])
        except BaseException as failure:
            result.update(status='failed', failure=repr(failure), logical_exact=None, native_exact=None, HTTP_exact=None)
            result.setdefault('original_failure', repr(failure))
            error = failure
        try:
            result['resources'], valid = resources()
        except BaseException as failure:
            valid = False
            result.update(status='failed', resources=None, resource_failure=True,
                          logical_exact=None, native_exact=None, HTTP_exact=None,
                          final_observer_outcome='unknown')
            result.setdefault('failure', repr(error or failure))
            result.setdefault('collection_errors', []).append(dict(stage='resources', error=repr(failure)))
            error = error or failure
        if not valid:
            result.update(status='failed', resource_failure=True, logical_exact=None, native_exact=None, HTTP_exact=None)
        try:
            save(output, result)
        except BaseException as failure:
            error = error or failure
    if error is not None:
        raise error
    assert valid, result
    print('PASS one real caller/local HTTP selection, original state retained; exact1 logical/native/HTTP', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['prepare', 'controls', 'negative', 'runtime'], required=True)
    parser.add_argument('--evidence-dir', type=Path)
    parser.add_argument('--folder', type=Path)
    parser.add_argument('--reservation-id')
    options = parser.parse_args()
    if options.stage == 'prepare':
        assert options.evidence_dir and not options.folder
        options.evidence_dir.mkdir(parents=True, exist_ok=True)
        prepare(options.evidence_dir)
    else:
        assert options.folder and options.folder.is_dir() and not options.evidence_dir
        if options.stage == 'runtime':
            assert options.reservation_id, 'parent shared-ledger reservation identifier required'
            runtime(options.folder, options.reservation_id)
        else:
            assert not options.reservation_id
            (controls if options.stage == 'controls' else negative)(options.folder)


if __name__ == '__main__':
    main()
