#!/usr/bin/env python3
"""One six-call scripted production prepare component, separately reviewed/run.

Prepare/controls consume no allocation. Only run reserves the existing shared
E_legacy_handlers bucket. The real prepare_work production handlers and six
String Agents run; this does not establish original E17 or completed work.
"""
import argparse
import base64
from collections import Counter
from copy import deepcopy
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

sys.dont_write_bytecode = True
PACKAGE = Path(__file__).resolve().parent.parent
PROFILE, BUCKET = 'e-prepare-readonly', 'E_legacy_handlers'
MOUNT = Path('/e-prepare-readonly')
PORT, MODEL = 18873, 'nomo-e-prepare-scripted'
TOKEN_ENV, TOKEN = 'NOMO_E_PREPARE_TEST_TOKEN', 'e-prepare-scripted-not-a-secret'
COUNT = 6
COMPONENT, CASE = 'HARNESS-HANDLER-001-prepare', 'prepare-work-readonly-6'
DIMENSIONS = ('logical_starts', 'native_starts', 'HTTP_attempts')
COMPONENT_CASES = {
    'CONTEXT-PREFLIGHT-001A-caller': ('optional-and-required-negative-1', 1),
    COMPONENT: (CASE, COUNT),
}
ACTORS = ['nomo.harness.harness_work_model.ReadPlan', 'nomo.agent.model_tool.ReadFirst',
          'nomo.agent.model_tool.ReadFinal', 'nomo.harness.harness_work_model.ReadAggregate',
          'nomo.harness.harness_work_model.EditPlan', 'nomo.harness.harness_work_model.EditChild']
QUALIFIED = ['Agentic.infer[' + actor + '.run, string]' for actor in ACTORS]
UNUSED_AGGREGATE = 'Agentic.infer[nomo.harness.harness_work_model.Aggregate.run, string]'
# QUALIFIED belongs to static effects/source metadata. Official006 native Host
# traces expose a generic action and request ID, without an Actor QName event.
NATIVE_MODEL_ACTION = 'Agentic.infer'


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def environment():
    # Carry only ordinary process paths/locale, never existing provider/policy
    # variables or private configuration. The only credential is fixed synthetic.
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ}
    env.update({TOKEN_ENV: TOKEN, 'ETAS_HOST_APPROVAL': 'deny', 'NO_COLOR': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
    return env


def helpers(root):
    sys.path.insert(0, str(root / 'tests'))
    from normal_graph_identity import verify_cli
    from model_protocol_probe import resources
    from terminal002_native_probe import TrackedHTTPServer
    spec = importlib.util.spec_from_file_location('e_prepare_existing_oracles', root / 'tests/fixtures/harness_work001/cases.py')
    cases = importlib.util.module_from_spec(spec); spec.loader.exec_module(cases)
    return verify_cli, resources, TrackedHTTPServer, cases


def sources(root):
    pending, found = ['nomo.entry.harness_work_entry'], {}
    while pending:
        module = pending.pop()
        if module in found: continue
        path = (root / 'src').joinpath(*module.split('.')).with_suffix('.es')
        body = path.read_text()
        assert re.findall(r'^\s*module\s+([\w.]+)\s*;', body, re.M) == [module], path
        found[module] = path
        for imported in re.findall(r'^\s*(?:public\s+)?import\s+(nomo(?:\.[A-Za-z_]\w*)*)[.\s;]', body, re.M):
            parts = imported.split('.')
            matches = ['.'.join(parts[:end]) for end in range(2, len(parts) + 1)
                       if (root / 'src').joinpath(*parts[:end]).with_suffix('.es').is_file()]
            assert len(matches) == 1, imported
            pending.append(matches[0])
    return found


def manifest():
    return f'''[package]
name = "handler-prepare-readonly"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "{PROFILE}"
[runtime.profiles.{PROFILE}]
boundary_policy = "e-prepare-readonly"
[runtime.profiles.{PROFILE}.model]
adapter = "omlx-openai"
model = "{MODEL}"
base_url = "http://127.0.0.1:{PORT}/v1"
api_key_env = "{TOKEN_ENV}"
allow_private = true
enable_thinking = false
[runtime.profiles.{PROFILE}.model.timeout]
request_deadline_ms = 30000
connect_timeout_ms = 2000
[runtime.profiles.{PROFILE}.model.retry]
attempts = 1
delay_ms = 0
[runtime.profiles.{PROFILE}.filesystem.regions."nomo.tools.workspace.ReadOnlyRoot"]
root = "{MOUNT}/context"
read = true
write = false
delete = false
[runtime.profiles.{PROFILE}.filesystem.regions."nomo.tools.edit_file.EditableRoot"]
root = "{MOUNT}/original"
read = true
write = false
delete = false
[runtime.profiles.{PROFILE}.policy]
mode = "local-static"
rules = ["console=allow", "model=allow", "memory=deny", "session=deny", "approval=deny", "command=deny", "filesystem:Fs.stat=allow", "filesystem:Fs.read=allow", "filesystem:Fs.atomic_replace=deny", "filesystem:Fs.write=deny", "filesystem:HostFilesystem.delete=deny"]
[runtime.profiles.{PROFILE}.approval]
mode = "deny"
[[bin]]
name = "handler-prepare"
module = "app.handler_prepare_probe"
flow = "observe"
profile = "{PROFILE}"
'''


def snapshot(folder):
    return {str(path.relative_to(folder)): dict(sha256=digest(path), bytes=path.stat().st_size)
            for path in sorted(folder.rglob('*')) if path.is_file()}


def helper_inputs(root):
    return {relative: digest(root / relative) for relative in
            ('tests/normal_graph_identity.py', 'tests/model_protocol_probe.py', 'tests/terminal002_native_probe.py',
             'tests/fixtures/harness_work001/cases.py', 'scripts/etas-latest-cli-bootstrap.py')}


def prepare(root, destination):
    _, _, _, cases = helpers(root)
    destination.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='e-prepare-', dir=destination)).resolve()
    project = folder / 'project'; (project / 'src/app').mkdir(parents=True)
    for source in sources(root).values():
        target = project / source.relative_to(root); target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    fixture = PACKAGE / 'tests/fixtures/harness_handler001/prepare_probe.es'
    (project / 'src/app/handler_prepare_probe.es').write_bytes(fixture.read_bytes())
    # This new package has no dependencies. Its lock belongs to its own manifest,
    # using the official v1 package/version/edition fingerprint, not Nomo's lock.
    (project / 'etas.lock').write_text('version = 1\nmanifest_fingerprint = "etas-lock-input:v1|package=handler-prepare-readonly|version=0.0.0|edition=2026"\npackage = []\n')
    (project / 'etas.toml').write_text(manifest())
    item = cases.case('production-prepare-readonly', id='e-prepare-' + uuid.uuid4().hex, workspace='e-prepare-fixture',
                      kind='prepare-only', calls=6, atomic=0, edit_reads=1, phase='pending', changed=False, aggregate=False, preview=False)
    fresh = folder / 'fresh-readonly'
    for relative, text in [('context/context.txt', item['context_files']['context.txt']), ('original/note.txt', item['before'])]:
        assert len(text.encode()) <= 2048
        path = fresh / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(text.encode()); path.chmod(0o444)
    for path in sorted([fresh, *[p for p in fresh.rglob('*') if p.is_dir()]], key=lambda p: len(p.parts), reverse=True): path.chmod(0o555)
    record = dict(task='HARNESS-HANDLER-001 prepare production component', status='prepared', component=COMPONENT, case_identity=CASE, source_root=str(root),
                  source_inputs=snapshot(project), helper_inputs=helper_inputs(root), case=item,
                  driver_sha256=digest(Path(__file__)), fixture_sha256=digest(fixture), readonly_fixture_snapshot=snapshot(fresh), commands=[],
                  planned=dict(logical=6, native=6, HTTP=6, context_reads=1, original_stat=1, original_reads=1, atomic=0),
                  runtime_bounds=dict(request_ms=30000, native_seconds=170, host_seconds=165, cleanup_seconds=15, total_seconds=180),
                  qualification='Only real prepare_work production String handlers/Agents through validated Pending. No work admission, available, execute, journal, Memory, Approval, summary or completed work. Does not replace original E17 full-record equality.')
    save(folder / 'results.json', record)
    print('PREPARED ' + str(folder)); print('READONLY_BIND ' + str(fresh) + ' -> ' + str(MOUNT))
    return folder


def guard(root, folder, record):
    project = folder / 'project'
    # Host/container paths may differ; exact helper/source bytes are the guard.
    assert helper_inputs(root) == record['helper_inputs'], 'source/helper provenance changed'
    files = {str(path.relative_to(project)): dict(sha256=digest(path), bytes=path.stat().st_size)
             for path in sorted(project.rglob('*')) if path.is_file() and '.etas' not in path.relative_to(project).parts}
    assert files == record['source_inputs'], 'isolated source/profile changed'
    assert digest(Path(__file__)) == record['driver_sha256'], 'driver changed after preparation'
    mounts = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == str(MOUNT)]
    assert len(mounts) == 1 and 'ro' in mounts[0][5].split(','), 'fresh fixture requires exact read-only mount'
    assert snapshot(MOUNT) == record['readonly_fixture_snapshot']
    assert set(record['readonly_fixture_snapshot']) == {'context/context.txt', 'original/note.txt'}
    assert all(item['bytes'] <= 2048 for item in record['readonly_fixture_snapshot'].values())
    assert record['planned'] == dict(logical=6, native=6, HTTP=6, context_reads=1, original_stat=1, original_reads=1, atomic=0)
    return project


def command(folder, label, argv, record):
    item = dict(label=label, command=list(map(str, argv))); record['commands'].append(item); save(folder / 'results.json', record)
    try:
        run = subprocess.run(item['command'], env=environment(), stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
        out, err = run.stdout, run.stderr
    except subprocess.TimeoutExpired as error:
        out, err = error.output or b'', error.stderr or b''
        (folder / (label + '.stdout.bin')).write_bytes(out); (folder / (label + '.stderr.bin')).write_bytes(err)
        item.update(timeout=True); save(folder / 'results.json', record); raise
    (folder / (label + '.stdout.bin')).write_bytes(out); (folder / (label + '.stderr.bin')).write_bytes(err)
    item.update(exit=run.returncode, stdout=out.decode(), stderr=err.decode()); save(folder / 'results.json', record)
    assert run.returncode == 0 and not err, (label, str(folder))
    return item['stdout']


def controls(root, folder, record):
    assert record['status'] == 'prepared'
    project = guard(root, folder, record); verify_cli, resources, _, _ = helpers(root); cli = verify_cli()
    command(folder, 'check', [cli, 'check', '--all', project], record)
    effects = command(folder, 'effects', [cli, 'effects', project, '--flow', 'observe'], record)
    support = re.findall(r'^\s*support:\s*(.+?)\s*$', effects, re.M)
    assert len(support) == 1 and re.fullmatch(r'(?:local|requires-host\[[^\n]*\]|requires-orchestration\[[^\n]*\])', support[0])
    assert all(name in effects for name in QUALIFIED), 'production Agent boundary missing'
    observed_actors = set(re.findall(r'Agentic\.infer\[[^\]]+\]', effects))
    assert observed_actors <= {*QUALIFIED, UNUSED_AGGREGATE}, 'unexpected production Agent'
    assert not any(name in effects for name in ('Memory.', 'Approval.request', 'Fs.atomic_replace', 'Fs.write', 'Console.stdin')), 'non-read-only reachable authority'
    profile = json.loads(command(folder, 'profile', [cli, 'run', project, '--flow', 'observe', '--profile', PROFILE, '--print-runtime-profile'], record))
    assert profile['approval'] == 'Deny' and profile['model']['retry'] == dict(attempts=1, delay_ms=0)
    assert profile['model']['timeout'] == dict(request_deadline_ms=30000, connect_timeout_ms=2000)
    assert profile['model']['provider'] == 'omlx-openai' and profile['model']['model'] == MODEL
    memory = profile.get('memory'); assert memory is None or memory == 'None' or (isinstance(memory, dict) and memory.get('kind') in ('none', 'disabled'))
    assert profile['session']['kind'] == 'none' and not profile.get('tools')
    regions = {value['identity']: value for value in profile['filesystem_regions']}
    assert set(regions) == {'nomo.tools.workspace.ReadOnlyRoot', 'nomo.tools.edit_file.EditableRoot'}
    for identity, leaf in [('nomo.tools.workspace.ReadOnlyRoot', 'context'), ('nomo.tools.edit_file.EditableRoot', 'original')]:
        region = regions[identity]
        assert region['root'] == str(MOUNT / leaf) and region['read'] is True and region['write'] is False and not region.get('delete')
    assert profile['adapter_transport_endpoints'] == [dict(host='127.0.0.1', port=PORT, scheme='http')]
    observed_resources, valid = resources(); assert valid
    record.update(status='controls-passed', controls=dict(Model=0, HTTP=0, source_root_at_controls=str(root), selected_cli=str(cli), selected_cli_sha256=digest(cli),
                  support=support[0], potential_agents=sorted(observed_actors), unused_aggregate_potential=UNUSED_AGGREGATE in observed_actors,
                  profile=profile, resources=observed_resources))
    save(folder / 'results.json', record); print('PASS source/effects/profile controls; zero Model/HTTP/reservation')


def validate_bucket(bucket):
    assert all(type(bucket[key]) is int for key in ('max_invocations', 'max_each', 'HTTP_attempts_per_request', 'invocations_used', *DIMENSIONS))
    assert (bucket['max_invocations'], bucket['max_each'], bucket['HTTP_attempts_per_request']) == (3, 12, 1)
    attempts = bucket['attempts']; assert isinstance(attempts, list)
    assert bucket['invocations_used'] == len(attempts) <= 3
    identities = set(); reserved = 0; known = {key: 0 for key in DIMENSIONS}
    observation_fields = {*DIMENSIONS, *(key + '_lower_bound' for key in DIMENSIONS)}
    for attempt in attempts:
        assert isinstance(attempt, dict)
        assert isinstance(attempt['id'], str) and attempt['id'].strip() and attempt['id'] not in identities
        identities.add(attempt['id'])
        assert attempt['component'] in COMPONENT_CASES
        case, count = COMPONENT_CASES[attempt['component']]
        assert attempt['case'] == case and type(attempt['reserved_each']) is int and attempt['reserved_each'] == count
        assert attempt['status'] in ('reserved', 'passed', 'failed')
        assert isinstance(attempt['evidence'], str) and attempt['evidence'].strip()
        assert isinstance(attempt['correction_review'], str)
        observed = attempt['observations']; assert isinstance(observed, dict) and set(observed) == observation_fields
        for key in DIMENSIONS:
            exact, lower = observed[key], observed[key + '_lower_bound']
            assert type(lower) is int and lower >= 0
            assert exact is None or (type(exact) is int and exact >= lower)
            known[key] += lower if exact is None else exact
            if attempt['status'] == 'passed': assert exact == count
        if attempt['status'] != 'reserved': assert attempt['reservation_retained'] is True
        reserved += count
    assert reserved <= 12
    assert all(bucket[key] >= 0 and bucket[key] == known[key] for key in DIMENSIONS), 'shared aggregate count differs from retained attempt observations'
    lower_bounds = any(attempt['observations'][key] is None for attempt in attempts for key in DIMENSIONS)
    if 'counts_are_lower_bounds' in bucket:
        assert type(bucket['counts_are_lower_bounds']) is bool and bucket['counts_are_lower_bounds'] == lower_bounds
    return reserved


def ledger_update(path, change):
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r+', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX); info = os.fstat(stream.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
        whole = json.load(stream); before_other = {key: deepcopy(value) for key, value in whole.items() if key != BUCKET}
        bucket = whole[BUCKET]
        validate_bucket(bucket); change(bucket)
        bucket['counts_are_lower_bounds'] = any(attempt['observations'][key] is None for attempt in bucket['attempts'] for key in DIMENSIONS)
        validate_bucket(bucket)
        assert {key: value for key, value in whole.items() if key != BUCKET} == before_other
        stream.seek(0); stream.truncate(); json.dump(whole, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def reserve(path, folder, review, correction):
    assert review, 'record the concrete root/PM-reviewed six-call component scope'
    identity = uuid.uuid4().hex
    def change(bucket):
        attempts = bucket['attempts']
        assert not any(item['status'] == 'reserved' for item in attempts), 'unresolved E reservation'
        same = [item for item in attempts if (item['component'], item['case']) == (COMPONENT, CASE)]
        assert not any(item['status'] == 'passed' for item in same), 'same completed prepare case must not replay'
        if same: assert same[-1]['status'] == 'failed' and correction.strip(), 'same prepare retry requires concrete correction review'
        reserved = validate_bucket(bucket)
        assert bucket['invocations_used'] < 3 and not bucket.get('overrun')
        assert all(max(reserved, bucket[key]) + COUNT <= 12 for key in DIMENSIONS), 'shared retained reservation or observed dimension exceeds total12'
        bucket['invocations_used'] += 1
        observations = {key: None for key in DIMENSIONS}
        observations.update({key + '_lower_bound': 0 for key in DIMENSIONS})
        attempts.append(dict(id=identity, component=COMPONENT, case=CASE, status='reserved', reserved_each=COUNT,
                             evidence=str(folder), correction_review=correction, observations=observations))
    ledger_update(path, change)
    return identity


def finish(path, identity, record):
    def change(bucket):
        attempt = next(item for item in bucket['attempts'] if item['id'] == identity); assert attempt['status'] == 'reserved'
        observations = {key: record['counts'][key] for key in (*DIMENSIONS, *(name + '_lower_bound' for name in DIMENSIONS))}
        attempt.update(status=record['status'], observations=observations, failure=record.get('failure'), reservation_retained=True)
        for key in DIMENSIONS:
            bucket[key] += record['counts'][key] if record['counts'][key] is not None else record['counts'][key + '_lower_bound']
        if max(record['counts']['HTTP_attempts_lower_bound'], record['counts']['native_starts_lower_bound']) > COUNT: bucket['overrun'] = True
    ledger_update(path, change)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def handle_one_request(self):
        self.record = None
        try: super().handle_one_request()
        finally:
            if self.record is None:
                self.server.unparsed.set(); self.server.fatal.set()

    def parse_request(self):
        if not super().parse_request():
            self.server.fatal.set(); return False
        with self.server.records_lock:
            self.server.attempts += 1
            self.record = dict(ordinal=self.server.attempts - 1, method=self.command, path_matches=self.path == '/v1/chat/completions',
                               received_monotonic=time.monotonic(), finished=threading.Event())
            self.server.records.append(self.record)
        if self.command != 'POST' or self.record['ordinal'] >= COUNT:
            self.server.fatal.set()
            try: self.send_error(503, 'unexpected method or extra HTTP attempt')
            finally: self.record['finished'].set()
            return False
        return True

    def update(self, **values):
        with self.server.records_lock: self.record.update(values)

    def do_POST(self):
        try:
            assert self.record['path_matches'] and self.headers.get('Authorization') == 'Bearer ' + TOKEN, 'unexpected synthetic endpoint/authentication'
            assert not self.headers.get('Transfer-Encoding'), 'unexpected request transfer framing'
            size = int(self.headers.get('Content-Length', '0')); assert 0 < size <= 196608, 'request body bound'
            raw = self.rfile.read(size); assert len(raw) == size, 'incomplete request body'
            request = json.loads(raw); ordinal = self.record['ordinal']; cases = self.server.cases; item = self.server.item
            self.update(request_base64=base64.b64encode(raw).decode(), request=request,
                        public_headers={key: self.headers[key] for key in ('Content-Type', 'Content-Length', 'Accept') if key in self.headers})
            assert request['model'] == MODEL and request['max_tokens'] == cases.OUTPUT[ordinal]
            assert request['chat_template_kwargs'] == dict(enable_thinking=False)
            assert not any(request.get(key) for key in ('tools', 'functions', 'tool_choice', 'function_call', 'response_format')), 'String Agent wire unexpectedly requested typed/tool output'
            assert [message['role'] for message in request['messages']] == ['system', 'user']
            assert isinstance(request['messages'][0]['content'], str) and request['messages'][0]['content'].strip(), 'complete production system body missing'
            context = json.loads(request['messages'][1]['content'])
            assert context == cases.context(item, ordinal, {}), 'complete production context differs'
            assert len(request['messages'][1]['content'].encode()) <= (2048 if ordinal < 4 else 65536)
            if ordinal == 0: text = cases.encoded(['delegate', item['read_task']])
            elif ordinal == 1: text = cases.encoded(cases.action(item))
            elif ordinal == 2: text = cases.encoded(['final', 'Seen: ' + context['history'][-1]['text']])
            elif ordinal == 3: text = 'Summary: ' + context['outcome']
            elif ordinal == 4: text = cases.encoded(['delegate', 'replace selected with ' + cases.selected_value(context['evidence']['operation'], context['evidence']['outcome'])])
            else: text = cases.encoded(['edit', 'old', cases.selected_value(context['evidence']['operation'], context['evidence']['outcome'])])
            usage = dict(prompt_tokens=10, completion_tokens=4, total_tokens=14)
            body = cases.encoded(dict(choices=[dict(message=dict(role='assistant', content=text), finish_reason='stop')], usage=usage)).encode()
            self.update(phase=cases.ORDER[ordinal], context=context, response_text=text, response_usage=usage,
                        response_status=200, response_base64=base64.b64encode(body).decode())
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body); self.wfile.flush(); self.update(response_write='completed')
        except BaseException as error:
            self.update(observer_error=type(error).__name__ + ': ' + str(error)); self.server.fatal.set()
            try: self.send_error(500, 'owned scripted observer rejected request')
            except (OSError, ValueError): pass
        finally: self.record['finished'].set()


def expected_pending(item, cases):
    return dict(selected=dict(id=item['id'], workspace=item['workspace'], path=item['path']),
                prepared=dict(request=dict(path=item['path'], original=item['before'], target=item['target'], replacement=item['replacement']),
                              proposal=dict(path=item['path'], before=item['before'], after=item['after'])),
                evidence=cases.evidence(item), request=item['request'], task=item['task'],
                state=dict(read=cases.READ_LEDGER, edit=dict(steps=4, calls=2, tokens=36864, native_tokens=98304, boundaries=2)))


def filesystem_observation(record, trace):
    item = record['case']; frozen = record['readonly_fixture_snapshot']
    bindings = {
        'context': dict(region='nomo.tools.workspace.ReadOnlyRoot', root=str(MOUNT / 'context'), path=item['allowed'][0],
                        declared_mounted_path=str(MOUNT / 'context' / item['allowed'][0]), **frozen['context/context.txt']),
        'original': dict(region='nomo.tools.edit_file.EditableRoot', root=str(MOUNT / 'original'), path=item['path'],
                         declared_mounted_path=str(MOUNT / 'original' / item['path']), **frozen['original/note.txt']),
    }
    finished = {event['id']: event for event in trace.get('events', []) if event['kind'] == 'host_request_finished'}
    observed = []; preceding_model = None; model_ordinal = 0
    for event in trace.get('events', []):
        if event['kind'] != 'host_request_started': continue
        action = event['qualified_action']
        if action == NATIVE_MODEL_ACTION:
            model_ordinal += 1
            preceding_model = dict(ordinal=model_ordinal, id=event['id'], action=action,
                                   declared_source_actor=ACTORS[model_ordinal - 1] if model_ordinal <= COUNT else None)
        if not action.startswith('Fs.'): continue
        preceding = preceding_model['ordinal'] if preceding_model is not None else None
        selected = 'context' if preceding == 2 and action == 'Fs.read' else (
            'original' if preceding == 4 and action in ('Fs.stat', 'Fs.read') else None)
        end = finished.get(event['id'])
        observed.append(dict(host_request_id=event['id'], action=action, request_kind=event.get('request_kind'),
                             subject_kind=event.get('subject_kind'), request_payload=event.get('payload'),
                             payload_top_level_absent=event.get('payload') is None, payload_digest=event.get('payload_digest'),
                             outcome=end.get('outcome') if end is not None else None, preceding_generic_model=preceding_model,
                             declared_binding_candidate=bindings[selected] if selected is not None else None,
                             declared_source_consumer_chain='read_context/work_child_turn/run_work_loop/read_file' if selected == 'context' else (
                                 'prepare_work/read_original/read_existing' if selected == 'original' else 'unmatched; do not infer a bound path')))
    return dict(observed_in_retained_trace=dict(Counter(event['action'] for event in observed)), events=observed,
                frozen_declared_readonly_bindings=bindings, expected_from_reviewed_source=dict(Fs_read=2, Fs_stat=1),
                independent_native_path_census=False, independent_runtime_qname_census=False,
                evidence_limit='Native request payload may be redacted and Model actions are generic Agentic.infer. Actor/consumer labels are declared frozen-source associations by generic Model ordinal, full HTTP system/context/caps and stage/Pending correlations. Declared paths are supported by read-only region/fixture bindings, unchanged bytes and actual outcomes; neither is an independent native QName/path census.')


def validate(record, trace, records, cases):
    assert record['exit'] == 0 and not record['stderr']
    assert len(records) == COUNT and all('observer_error' not in item and item['response_write'] == 'completed' for item in records)
    assert [item['phase'] for item in records] == cases.ORDER[:COUNT]
    assert all(item['context'] == cases.context(record['case'], index, {}) for index, item in enumerate(records))
    assert len(record['HTTP_system_bodies']) == COUNT
    usage = Counter()
    for item in records:
        returned = json.loads(base64.b64decode(item['response_base64']))['usage']
        assert returned == item['response_usage'] == dict(prompt_tokens=10, completion_tokens=4, total_tokens=14)
        usage.update(returned)
    assert dict(usage) == dict(prompt_tokens=60, completion_tokens=24, total_tokens=84)
    lines = record['stdout'].splitlines(); pending = [line[len('PENDING '):] for line in lines if line.startswith('PENDING ')]
    assert len(pending) == 1 and json.loads(pending[0]) == expected_pending(record['case'], cases), 'whole actual Pending differs'
    assert lines[-1] == 'PREPARE_ONLY no admission, journal, approval, atomic write or completed edit'
    assert not any(line.startswith(prefix) for line in lines for prefix in ('PREVIEW ', 'CONFIRM ', 'INTENT ', 'APPLIED ', 'FINAL ', 'EDIT completed ', 'REFUSED '))
    stages = [line.split()[1] for line in lines if line.startswith('STAGE ')]
    assert stages == ['read-plan', 'read-child', 'read-aggregate', 'edit-plan', 'edit-child']
    assert 'LEDGER work steps=11/13 calls=6/7 generation_allowance=45056/47104 native_token_ceiling=131072/196608' in record['stdout']
    assert trace['schema'] == 'etas.cli.interpreter-report.v1' and trace.get('incomplete') is not True
    assert trace['outcome']['kind'] == 'completed' and trace['termination']['local_work_settled'] is True
    starts = [item for item in trace['events'] if item['kind'] == 'host_request_started']
    ends = [item for item in trace['events'] if item['kind'] == 'host_request_finished']
    assert len(starts) == len(ends) and len({item['id'] for item in starts}) == len(starts) and {item['id'] for item in starts} == {item['id'] for item in ends}
    by_id = {item['id']: item for item in ends}
    names = [item['qualified_action'] for item in starts]
    assert set(names) <= {NATIVE_MODEL_ACTION, 'Policy.evaluate', 'Console.stdout_write', 'Fs.stat', 'Fs.read'}, 'unexpected Host authority'
    models = [item for item in starts if item['qualified_action'] == NATIVE_MODEL_ACTION]
    assert len(models) == COUNT, 'native generic Agentic inference count differs'
    assert all(by_id[item['id']]['outcome']['kind'] == 'succeeded' for item in starts)
    sequence = [name for name in names if name == NATIVE_MODEL_ACTION or name.startswith('Fs.')]
    assert sequence == [NATIVE_MODEL_ACTION, NATIVE_MODEL_ACTION, 'Fs.read', NATIVE_MODEL_ACTION, NATIVE_MODEL_ACTION, 'Fs.stat', 'Fs.read', NATIVE_MODEL_ACTION, NATIVE_MODEL_ACTION]
    positions = {(item['kind'], item['id']): index for index, item in enumerate(trace['events']) if item['kind'] in ('host_request_started', 'host_request_finished')}
    relevant = [item for item in starts if item['qualified_action'] == NATIVE_MODEL_ACTION or item['qualified_action'].startswith('Fs.')]
    assert all(positions['host_request_finished', left['id']] < positions['host_request_started', right['id']] for left, right in zip(relevant, relevant[1:])), 'next stage preceded actual previous completion'
    associations = []
    for index, (native, http) in enumerate(zip(models, records)):
        assert http['ordinal'] == index
        system = http['request']['messages'][0]['content']
        associations.append(dict(native_model_ordinal=index + 1, native_host_request_id=native['id'], native_qualified_action=native['qualified_action'],
                                 HTTP_ordinal=http['ordinal'], phase=http['phase'], actual_system_body=system,
                                 system_sha256=hashlib.sha256(system.encode()).hexdigest(), actual_complete_context=http['context'],
                                 actual_generation_cap=http['request']['max_tokens'], declared_source_actor=ACTORS[index],
                                 static_effect_signature=QUALIFIED[index]))
    return dict(actual_Pending=json.loads(pending[0]), host_actions=dict(Counter(names)), backend_reported_usage=dict(usage),
                ordinal_correlations=associations, independent_runtime_qname_census=False,
                actor_association_limit='The accepted cases.py provides complete Context/cap goldens but no exact system-body oracle. All six complete raw system bodies are retained for independent TL/source review. Source Actor association follows frozen production handlers plus generic Model IDs/order, HTTP systems/full Contexts/caps, stages and Pending; no independent runtime Actor QName census is claimed.',
                configured_allowances=dict(steps=11, calls=6, generation=45056, native_cumulative_ceiling=131072),
                qualification='Backend-reported usage is distinct from configured source allowances. No completed edit, E17 record-equality or whole-E acceptance.')


def execute(root, folder, record, ledger, review, correction):
    assert record['status'] == 'controls-passed' and not record.get('ledger_attempt')
    project = guard(root, folder, record); verify_cli, resources, TrackedHTTPServer, cases = helpers(root); cli = verify_cli()
    assert digest(cli) == record['controls']['selected_cli_sha256']
    began = time.monotonic(); deadline = began + 180
    try: server = TrackedHTTPServer(('127.0.0.1', PORT))
    except BaseException as error:
        record.update(status='run-setup-failed', failure=repr(error), allocation_reserved=False,
                      qualification='Listener setup failed before reservation, native spawn or HTTP request; no port owner was stopped.')
        save(folder / 'results.json', record); return 1
    server.RequestHandlerClass = Handler
    server.item, server.cases = record['case'], cases
    server.records, server.records_lock, server.attempts = [], threading.Lock(), 0
    server.fatal, server.unparsed = threading.Event(), threading.Event()
    thread = threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=.01), daemon=True)
    identity = process = None; out = err = b''; errors = []; stable = settled = False; trace = {}; native = 0; spawn_attempted = False
    try:
        thread.start(); identity = reserve(ledger, folder, review, correction)
        record.update(status='running', ledger_attempt=identity, review_reference=review, correction_review=correction); save(folder / 'results.json', record)
        record['resources_before'], valid = resources(); assert valid
        item = record['case']; args = ['--id', item['id'], '--workspace', item['workspace'], '--path', item['path'], '--once', item['request'], '--allow', ','.join(item['allowed'])]
        argv = [str(cli), 'run', str(project), '--flow', 'observe', '--profile', PROFILE, '--budget-time', '170s', '--allow-effects', '--trace-out', str(folder / 'native.trace.json'), '--args', *args]
        record['actual_command'] = argv; save(folder / 'results.json', record)
        spawn_attempted = True
        process = subprocess.Popen(argv, cwd=root, env=environment(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        record['owned_native_pid'] = process.pid
        while True:
            if server.fatal.is_set(): raise RuntimeError('scripted observer fail-stop')
            remaining = began + 165 - time.monotonic()
            if remaining <= 0: raise TimeoutError('owned native exceeded165seconds')
            try: out, err = process.communicate(timeout=min(.25, remaining)); break
            except subprocess.TimeoutExpired as error:
                if error.output is not None: out = error.output
                if error.stderr is not None: err = error.stderr
    except BaseException as error: errors.append(repr(error))
    finally:
        cleanup = min(deadline, time.monotonic() + 15)
        if process is not None:
            try:
                if process.poll() is None: os.killpg(process.pid, signal.SIGTERM)
                try: out, err = process.communicate(timeout=max(.01, min(2, cleanup - time.monotonic())))
                except subprocess.TimeoutExpired as error:
                    if error.output is not None: out = error.output
                    if error.stderr is not None: err = error.stderr
                    if process.poll() is None: os.killpg(process.pid, signal.SIGKILL)
                    try: out, err = process.communicate(timeout=max(.01, min(1, cleanup - time.monotonic())))
                    except subprocess.TimeoutExpired as last:
                        if last.output is not None: out = last.output
                        if last.stderr is not None: err = last.stderr
                        errors.append('owned native termination unconfirmed')
            except BaseException as error: errors.append(repr(error))
        stopper = None
        if thread.ident is not None:
            stopper = threading.Thread(target=server.shutdown, daemon=True); stopper.start()
            stopper.join(timeout=max(0, min(1, cleanup - time.monotonic())))
            thread.join(timeout=max(0, min(1, cleanup - time.monotonic())))
        server.abort_sockets(); joined = server.joined(cleanup); server.server_close()
        with server.records_lock:
            records = deepcopy([{key: value for key, value in item.items() if key != 'finished'} for item in server.records])
            finished = all(item['finished'].is_set() for item in server.records); http = server.attempts
        stable = (stopper is None or not stopper.is_alive()) and not thread.is_alive() and joined and finished and not server.unparsed.is_set()
        if not stable: errors.append('HTTP observer did not settle; exact counts unproven')
        record.update(exit=process.poll() if process is not None else None, stdout=out.decode(errors='replace'), stderr=err.decode(errors='replace'), HTTP=records,
                      observer_stable=stable, startup_closure_unproven=spawn_attempted and process is None,
                      owned_cleanup_confirmed=stable and (not spawn_attempted or (process is not None and process.poll() is not None)))
        record['HTTP_system_bodies'] = []
        for request in records:
            body = request.get('request'); messages = body.get('messages') if isinstance(body, dict) else None
            if isinstance(messages, list) and messages and isinstance(messages[0], dict):
                system = messages[0].get('content')
                if messages[0].get('role') == 'system' and isinstance(system, str):
                    record['HTTP_system_bodies'].append(dict(HTTP_ordinal=request['ordinal'], actual_system_body=system,
                                                            system_sha256=hashlib.sha256(system.encode()).hexdigest()))
        (folder / 'runtime.stdout.bin').write_bytes(out); (folder / 'runtime.stderr.bin').write_bytes(err)
        path = folder / 'native.trace.json'
        if path.exists():
            try: trace = json.loads(path.read_text())
            except ValueError as error: errors.append(repr(error))
        starts = [item for item in trace.get('events', []) if item['kind'] == 'host_request_started']
        ends = [item for item in trace.get('events', []) if item['kind'] == 'host_request_finished']
        record['filesystem_observation'] = filesystem_observation(record, trace)
        record['readonly_fixture_unchanged'] = None
        try:
            record['readonly_fixture_after'] = snapshot(MOUNT)
            record['readonly_fixture_unchanged'] = record['readonly_fixture_after'] == record['readonly_fixture_snapshot']
            if not record['readonly_fixture_unchanged']: errors.append('fresh read-only fixture contents changed')
        except BaseException as error: errors.append(repr(error))
        native = sum(item['qualified_action'].startswith(('Agentic.infer', 'Model.infer')) for item in starts)
        start_ids = [item.get('id') for item in starts]; end_ids = [item.get('id') for item in ends]
        valid_ids = all(type(value) in (int, str) and str(value) != '' for value in start_ids + end_ids)
        settled = (process is not None and process.poll() is not None
                   and trace.get('schema') == 'etas.cli.interpreter-report.v1' and trace.get('incomplete') is not True
                   and isinstance(trace.get('outcome'), dict) and trace['outcome'].get('kind') in ('completed', 'failed', 'cancelled')
                   and isinstance(trace.get('termination'), dict) and trace['termination'].get('local_work_settled') is True
                   and valid_ids and len(start_ids) == len(set(start_ids)) == len(end_ids) == len(set(end_ids))
                   and set(start_ids) == set(end_ids))
        resource_valid = False
        try:
            record['resources_after'], resource_valid = resources()
            if not resource_valid: errors.append('ordinary4GiB resource guard failed')
        except BaseException as error: errors.append(repr(error))
        if time.monotonic() > deadline: errors.append('run plus owned cleanup exceeded180seconds')
        qualified = False
        try:
            assert record['owned_cleanup_confirmed'] and process is not None and settled and not server.fatal.is_set()
            assert http == native == len(records) == COUNT
            record['validation'] = validate(record, trace, records, cases)
            assert record['readonly_fixture_unchanged'] is True
            assert resource_valid
            assert time.monotonic() <= deadline
            qualified = not errors
        except BaseException as error: errors.append(repr(error))
        record['counts'] = dict(logical_starts=COUNT if qualified else None, logical_starts_lower_bound=COUNT if qualified else 0,
                               native_starts=native if settled else None, native_starts_lower_bound=native,
                               HTTP_attempts=http if stable else None, HTTP_attempts_lower_bound=http,
                               Fs_read_starts_observed_in_trace=sum(item['qualified_action'] == 'Fs.read' for item in starts),
                               Fs_stat_starts_observed_in_trace=sum(item['qualified_action'] == 'Fs.stat' for item in starts),
                               trace_settled=settled, observer_stable=stable, reservation_retained=COUNT,
                               qualification='Exact logical6 only after complete production/context/Pending proof. Exact native count requires official complete report, unique paired IDs, reaped process and local_work_settled. Failed or unsettled proof retains all6 reserved calls; unknown exact values use observed lower bounds without refund.')
        record['counts_are_lower_bounds'] = any(record['counts'][key] is None for key in DIMENSIONS)
        record.update(status='passed' if qualified else 'failed', failure=errors or None, elapsed_seconds=time.monotonic() - began)
        save(folder / 'results.json', record)
        if identity is not None: finish(ledger, identity, record)
    print(record['status'].upper() + ' ' + str(folder)); return 0 if record['status'] == 'passed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=PACKAGE)
    parser.add_argument('--stage', choices=('prepare', 'controls', 'run'), required=True)
    parser.add_argument('--evidence-dir', type=Path); parser.add_argument('--folder', type=Path)
    parser.add_argument('--ledger', type=Path); parser.add_argument('--review-reference', default='')
    parser.add_argument('--correction-review', default='', help='Concrete correction review required only for a failed repeat of this same prepare case')
    args = parser.parse_args(); root = args.source_root.resolve()
    if args.stage == 'prepare':
        assert args.evidence_dir; prepare(root, args.evidence_dir); return 0
    assert args.folder and args.folder.is_absolute()
    record = json.loads((args.folder / 'results.json').read_text())
    if args.stage == 'controls':
        try: controls(root, args.folder, record)
        except BaseException as error:
            record.update(status='controls-failed', failure=repr(error), controls_Model=0, controls_HTTP=0); save(args.folder / 'results.json', record); raise
        return 0
    assert args.ledger and args.ledger.is_file() and args.review_reference
    return execute(root, args.folder, record, args.ledger, args.review_reference, args.correction_review)


if __name__ == '__main__': raise SystemExit(main())
