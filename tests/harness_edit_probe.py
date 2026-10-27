#!/usr/bin/env python3
"""Actual Model/main/edit-child/main observations on private disposable fixtures.

The accepted edit observer supplies PTY confirmation, independent SQL decoding
and exact request/preview oracles. This runner supplies bounded loopback Model
replies and observes the new real entry; it never implements product decisions.
"""
import argparse
import base64
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import tomllib

import edit_write_probe as edit
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT/'tests/fixtures/harness_edit001/cases.py'
spec = importlib.util.spec_from_file_location('harness_edit_exact_cases', FIXTURE)
cases = importlib.util.module_from_spec(spec); spec.loader.exec_module(cases)
original_environment = edit.environment


def environment(apply=True):
    env = original_environment(apply)
    for key in list(env):
        if key.startswith('ETAS_HOST_MODEL') or key == 'ETAS_HOST_OMLX_API_KEY': env.pop(key)
    env['NOMO_HARNESS_EDIT_TEST_KEY'] = cases.TOKEN
    return env


# Reuse the genuine accepted PTY driver with the fixture's synthetic API key.
edit.environment = environment


def manifest(state, workspace, *, status=False):
    text = edit.manifest(state, workspace, status)
    text = text.replace('http://model-gateway:8080/v1', 'http://127.0.0.1:'+str(cases.PORT)+'/v1')
    text = text.replace('http://143.89.191.75:8095/v1', 'http://127.0.0.1:'+str(cases.PORT)+'/v1')
    text = text.replace('NOMO_GATEWAY_CLIENT_TOKEN', 'NOMO_HARNESS_EDIT_TEST_KEY')
    text = text.replace('NOMO_QWEN_SERVER_API_KEY', 'NOMO_HARNESS_EDIT_TEST_KEY')
    text = text.replace('request_deadline_ms = 120000', 'request_deadline_ms = 2000')
    text = text.replace('connect_timeout_ms = 2000', 'connect_timeout_ms = 200')
    assert 'http://model-gateway' not in text and '143.89.191.75' not in text
    parsed = tomllib.loads(text)['runtime']['profiles']
    if not status:
        profile = parsed['harness-edit']
        assert profile['model']['model'] == cases.MODEL and profile['model']['api_key_env'] == 'NOMO_HARNESS_EDIT_TEST_KEY'
        assert profile['model']['retry'] == dict(attempts=1, delay_ms=0)
        assert profile['approval'] == dict(mode='prompt')
        assert profile['memory'] == dict(backend='sqlite', path=str(state/'edit.sqlite3'))
        assert profile['filesystem']['regions'] == {edit.REGION: dict(root=str(workspace), read=True, write=True, delete=False)}
    else:
        assert all(not any(kind in value for kind in ['model', 'filesystem', 'approval']) for value in parsed.values())
    return text


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(size) if 0 < size <= 131072 else b''
        record = dict(path=self.path, request_base64=base64.b64encode(raw).decode(),
                      received_utc=datetime.now(timezone.utc).isoformat(), received_monotonic=time.monotonic(),
                      finished=threading.Event())
        with self.server.records_lock:
            ordinal = len(self.server.records); self.server.records.append(record)
        try:
            request = json.loads(raw); context = json.loads(request['messages'][1]['content'])
            phase = ['plan', 'child', 'aggregate'][ordinal]
            record.update(request=request, context=context, phase=phase, journal_at_request=edit.rows(self.server.state))
            assert self.path == '/v1/chat/completions'
            assert self.headers.get('Authorization') == 'Bearer '+cases.TOKEN
            assert context['phase'] == phase
            item = self.server.item
            if phase == 'plan': text = item.get('plan_raw', cases.encoded(['delegate', 'replace with '+context['request']]))
            elif phase == 'child':
                replacement = context['task'][len('replace with '):] if item['source'] == 'task' else item['replacement']
                text = item.get('child_raw', cases.encoded(['edit', item['target'], replacement]))
            else: text = item.get('final_text', cases.final_answer(context))
            mode = item.get('fail_mode', 'ok') if item.get('fail_phase') == phase else 'ok'
            prompt_tokens = item.get('usage_prompt_tokens', 10)
            body = dict(choices=[dict(message=dict(role='assistant', content=text), finish_reason='stop')],
                        usage=dict(prompt_tokens=prompt_tokens, completion_tokens=4, total_tokens=prompt_tokens+4))
            code = 200
            if mode == 'unavailable': code, body = 503, dict(error=dict(message='owned aggregate fixture unavailable'))
            if mode == 'token_overrun': body['usage'] = dict(prompt_tokens=cases.PHASE_CONTEXT_TOKENS[phase], completion_tokens=1, total_tokens=cases.PHASE_CONTEXT_TOKENS[phase]+1)
            data = cases.encoded(body).encode()
            record.update(response_status=code, response_text=text, fixture_mode=mode,
                          response_base64=base64.b64encode(data).decode())
            self.send_response(code); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data))); self.end_headers()
            try: self.wfile.write(data); record['response_write'] = 'completed'
            except (BrokenPipeError, ConnectionResetError): record['response_write'] = 'client already aborted'
        except Exception as error:
            record['observer_error'] = repr(error)
            try: self.send_error(500, 'owned fixture observation failed')
            except (BrokenPipeError, ConnectionResetError): pass
        finally:
            record['finished'].set()


def model_action(action):
    return action == 'Model.infer' or action.startswith('Agentic.infer')


def actions(trace):
    return [event['qualified_action'] for event in trace['events'] if event['kind'] == 'host_request_started']


def assert_http(item, records, binding):
    assert len(records) == item['calls'], 'Model request count: no retry or later aggregation is permitted'
    systems = {}
    for index, record in enumerate(records):
        assert 'observer_error' not in record, record
        request, context = record['request'], record['context']; phase = ['plan', 'child', 'aggregate'][index]
        assert request['model'] == cases.MODEL and request['max_tokens'] == cases.PHASE_TOKENS[phase]
        assert request['chat_template_kwargs'] == dict(enable_thinking=False)
        assert [message['role'] for message in request['messages']] == ['system', 'user']
        assert len(request['messages'][1]['content'].encode()) <= cases.CONTEXT_BYTES
        expected = cases.aggregate_fields(item, binding)
        if phase != 'aggregate':
            expected.update(phase=phase, task='' if phase == 'plan' else item['task'], after='', request_digest='',
                            before_digest='', after_digest='', before_bytes=len(item['before'].encode()), after_bytes=0, completed=False)
        assert context == expected, 'actual task/original/typed completed outcome differs'
        if phase == 'aggregate':
            assert record['journal_at_request']['operation']['value'] == dict(format=1, phase='completed', binding=binding)
        else: assert record['journal_at_request'] == {}, 'intent preceded current confirmation'
        system = request['messages'][0]['content']
        systems[phase] = system
    if 'child' in systems:
        assert all(system != systems['child'] for phase, system in systems.items() if phase != 'child'), 'separate child system required'


def assert_trace(item, trace):
    started = [event for event in trace['events'] if event['kind'] == 'host_request_started']
    observed = [event['qualified_action'] for event in started]
    assert all(model_action(action) or action in {'Policy.evaluate', 'Memory.read', 'Memory.write', 'Approval.request',
               'Console.stdout_write', 'Console.stdin_read_line', 'Fs.stat', 'Fs.read', 'Fs.atomic_replace'} for action in observed)
    models = [event for event in started if model_action(event['qualified_action'])]
    atomics = [event for event in started if event['qualified_action'] == 'Fs.atomic_replace']
    writes = [event for event in started if event['qualified_action'] == 'Memory.write']
    assert len(models) == item['calls'] and len(atomics) == item['atomic']
    assert observed[0] == 'Policy.evaluate' and next(action for action in observed if action != 'Policy.evaluate') == 'Memory.read'
    assert observed.count('Fs.read') <= 3 and observed.count('Fs.stat') == observed.count('Fs.read')
    assert len(writes) == (2 if item['phase'] == 'completed' or item['kind'] == 'completion_error' else 1 if item['phase'] == 'intent' else 0)
    events = trace['events']; by_id = {event['id']: event['qualified_action'] for event in started}
    positions = {(event['kind'], event['id']): index for index, event in enumerate(events) if event['kind'] in ['host_request_started', 'host_request_finished']}
    before = lambda first, second: positions[('host_request_finished', first['id'])] < positions[('host_request_started', second['id'])]
    if atomics:
        assert before(writes[0], atomics[0]), 'intent write must finish before atomic dispatch'
        middle = events[positions[('host_request_finished', writes[0]['id'])]+1:positions[('host_request_started', atomics[0]['id'])]]
        assert any(event['kind'] == 'host_request_finished' and by_id[event['id']] == 'Memory.read' for event in middle), 'intent readback missing'
    if item['aggregate']:
        assert before(writes[1], models[2]), 'completion write must finish before aggregation'
        middle = events[positions[('host_request_finished', writes[1]['id'])]+1:positions[('host_request_started', models[2]['id'])]]
        assert any(event['kind'] == 'host_request_finished' and by_id[event['id']] == 'Memory.read' for event in middle)
    if item['kind'] in ['non_tty', 'native_no']: assert 'Console.stdin_read_line' not in observed
    return observed


def run_case(cli, evidence, item):
    case = evidence/item['name']; state = case/'state'; workspace = case/'workspace'
    state.mkdir(parents=True, mode=0o700)
    if item['kind'] == 'read_only':
        workspace = Path('/edit-fixture-readonly')
        mount = next(line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == str(workspace))
        assert 'ro' in mount[5].split(',') and (workspace/item['path']).read_bytes() == item['before'].encode()
    else:
        workspace.mkdir(mode=0o700); (workspace/item['path']).write_bytes(item['before'].encode()); (workspace/item['path']).chmod(0o600)
    for label, status in [('project', False), ('status-project', True)]:
        project = case/label; shutil.copytree(ROOT/'src', project/'src'); shutil.copyfile(ROOT/'etas.lock', project/'etas.lock')
        (project/'etas.toml').write_text(manifest(state, workspace, status=status))
    args = ['--id', item['id'], '--workspace', item['workspace'], '--path', item['path']]
    argv = [str(cli), 'run', str(case/'project'), '--flow', 'harness_edit', '--allow-effects', '--trace-out', str(case/'apply.trace.json'), '--args', *args, '--once', item['request']]
    profile = subprocess.run([str(cli), 'run', str(case/'project'), '--flow', 'harness_edit', '--print-runtime-profile'], cwd=state, env=environment(), capture_output=True, timeout=15)
    (case/'profile.stdout.bin').write_bytes(profile.stdout); (case/'profile.stderr.bin').write_bytes(profile.stderr)
    assert profile.returncode == 0 and not profile.stderr
    effective = json.loads(profile.stdout)
    assert effective['profile'] == 'harness-edit' and effective['approval'] == 'Prompt' and effective['model'] is not None
    assert effective['memory'] == dict(kind='sqlite', path=str(state/'edit.sqlite3'))
    assert effective['filesystem_regions'] == [dict(identity=edit.REGION, root=str(workspace), read=True, write=True, delete=False)]
    binding, preview = edit.expected(item)
    server = ThreadingHTTPServer(('127.0.0.1', cases.PORT), Handler); server.daemon_threads = True
    server.item, server.state, server.records, server.records_lock = item, state, [], threading.Lock()
    thread = threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=0.01), daemon=True); thread.start()
    record = dict(name=item['name'], item=item, argv=argv, effective_profile=effective, status='running')
    try:
        if item['kind'] == 'non_tty':
            proc = subprocess.Popen(argv, cwd=state, env=environment(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                proc.wait(timeout=20); out = proc.stdout.read(); err = proc.stderr.read(); code = proc.returncode
            finally:
                if proc.poll() is None: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
                proc.stdin.close(); proc.stdout.close(); proc.stderr.close()
            milestones = ['open_pipe_terminated']
        else: out, err, code, milestones = edit.run_pty(argv, state, item, workspace, binding)
        (case/'apply.stdout.bin').write_bytes(out); (case/'apply.stderr.bin').write_bytes(err)
        record.update(exit=code, stdout=out.decode(), stderr=err.decode(), milestones=milestones)
        assert (code == 0) == item['exit_zero']
        assert (preview.encode() in out) == item['preview']
        if item['preview']:
            line = next(line for line in out.splitlines() if line.startswith(b'PREVIEW '))
            assert all(32 <= byte <= 126 for byte in line), 'preview contains raw terminal data'
        journal = edit.rows(state); current = (workspace/item['path']).read_bytes()
        assert (b'APPLIED '+item['id'].encode() in out) == (item['phase'] == 'completed')
        if item['phase'] == 'empty': assert journal == {}
        else: assert journal['operation']['value'] == dict(format=1, phase=item['phase'], binding=binding)
        assert current == (b'external change' if item['kind'] == 'mismatch' else item['after'].encode() if item['changed'] else item['before'].encode())
        assert (b'FINAL ' in out) == item['exit_zero']
        if item['exit_zero']:
            final = next(line[len(b'FINAL '):] for line in out.splitlines() if line.startswith(b'FINAL '))
            assert json.loads(final) == [cases.final_answer(cases.aggregate_fields(item, binding))]
            assert all(byte == 10 or 32 <= byte <= 126 for byte in out), 'Console must escape admitted task/summary controls and Unicode'
        if item['phase'] == 'completed' and not item['exit_zero']:
            after_applied = out.split(b'APPLIED ', 1)[1].lower()
            assert b'edit_status' in after_applied and b'completed' in after_applied
            assert b'unmodified' not in after_applied and b'not applied' not in after_applied
        assert err.count(b'Type `yes` to approve:') == (1 if item['preview'] and item['kind'] != 'non_tty' else 0)
        trace = json.loads((case/'apply.trace.json').read_text()); record['actions'] = assert_trace(item, trace)
        assert_http(item, server.records, binding)
        before = edit.previous.inspect(state); (case/'status.before.json').write_text(json.dumps(before, indent=2)+'\n')
        status_argv = [str(cli), 'run', str(case/'status-project'), '--flow', 'edit_status', '--allow-effects', '--trace-out', str(case/'status.trace.json'), '--args', *args]
        shown = subprocess.run(status_argv, cwd=state, env=environment(False), input=b'', capture_output=True, timeout=20)
        (case/'status.stdout.bin').write_bytes(shown.stdout); (case/'status.stderr.bin').write_bytes(shown.stderr)
        after = edit.previous.inspect(state); (case/'status.after.json').write_text(json.dumps(after, indent=2)+'\n')
        assert shown.returncode == 0 and not shown.stderr and after == before
        stored = json.loads(shown.stdout.decode().splitlines()[0][len('OPERATION '):]); assert stored['phase'] == item['phase']
        if journal: assert stored == dict(format='nomo-edit-operation-v1', phase=item['phase'], **{key: str(value) for key, value in binding.items()})
        status_actions = actions(json.loads((case/'status.trace.json').read_text()))
        assert set(status_actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'}
        assert status_actions.count('Memory.read') == (2 if journal else 1)
        retries = []
        if journal:
            for opid in [item['id'], 'different-id']:
                retry = list(argv); retry[retry.index('--id')+1] = opid
                retry[retry.index('--trace-out')+1] = str(case/('retry-'+opid+'.trace.json'))
                refused = subprocess.run(retry, cwd=state, env=environment(), input=b'', capture_output=True, timeout=20)
                (case/('retry-'+opid+'.stdout.bin')).write_bytes(refused.stdout); (case/('retry-'+opid+'.stderr.bin')).write_bytes(refused.stderr)
                retrace = actions(json.loads(Path(retry[retry.index('--trace-out')+1]).read_text()))
                assert refused.returncode != 0 and b'edit operation slot already consumed; no retry' in refused.stdout
                assert set(retrace) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'} and retrace.count('Memory.read') == 1
                retries.append(dict(id=opid, argv=retry, exit=refused.returncode, actions=retrace))
            assert edit.previous.inspect(state) == after and (workspace/item['path']).read_bytes() == current
        assert len(server.records) == item['calls'], 'status or consumed-store replay dispatched a Model request'
        record.update(status='passed', journal=journal, status_argv=status_argv, status_actions=status_actions, retries=retries)
        return record
    except BaseException as error:
        record.update(status='failed', failure=repr(error)); raise
    finally:
        server.shutdown(); thread.join(timeout=2)
        for request in server.records: request['finished'].wait(2)
        server.server_close()
        requests = [{key: value for key, value in request.items() if key != 'finished'} for request in server.records]
        (case/'http.json').write_text(json.dumps(requests, indent=2)+'\n')
        (case/'observation.json').write_text(json.dumps(record, indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--suite', choices=['smoke', 'matrix', 'readonly', 'all'], default='smoke')
    parser.add_argument('--case', action='append', dest='names')
    parser.add_argument('--prepare-only', action='store_true')
    options = parser.parse_args(); selected = cases.selected(options.suite)
    if options.names:
        selected = [item for item in cases.cases() if item['name'] in options.names]
        assert set(options.names) == {item['name'] for item in selected}
    options.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='harness-edit-', dir=options.evidence_dir))
    (evidence/'cases.json').write_text(json.dumps(selected, indent=2)+'\n')
    print('EVIDENCE '+str(evidence), flush=True)
    if options.prepare_only: return
    result = dict(task='HARNESS-EDIT-001A', status='running', suite=options.suite, cases=[])
    save = lambda: (evidence/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    save()
    try:
        assert os.getuid() == 10001
        cli = verify_cli()
        for item in selected:
            result['cases'].append(run_case(cli, evidence, item)); save(); print('PASS '+item['name'], flush=True)
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'] = {name: (Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.max']}
        r = result['resources']; events = dict(line.split() for line in r['memory.events'].splitlines())
        valid = r['memory.max'] == '4294967296' and r['cpu.max'] == '400000 100000' and r['pids.max'] == '256' and all(events[key] == '0' for key in ['max', 'oom', 'oom_kill', 'oom_group_kill'])
        if not valid: result.update(status='failed', resource_failure='ordinary resource guard failed')
        save(); assert valid


if __name__ == '__main__': main()
