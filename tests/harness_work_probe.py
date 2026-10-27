#!/usr/bin/env python3
"""Actual bounded read-context/edit workflow; reused HTTP/PTY/SQL primitives."""
import argparse
import base64
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
import tomllib

import harness_edit_probe as accepted
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('work_exact_cases', ROOT/'tests/fixtures/harness_work001/cases.py')
cases = importlib.util.module_from_spec(spec); spec.loader.exec_module(cases)
edit = accepted.edit
environment, actions, model_action = accepted.environment, accepted.actions, accepted.model_action
PORT, TOKEN, MODEL = accepted.cases.PORT, accepted.cases.TOKEN, accepted.cases.MODEL


def manifest(state, workspace, context, *, status=False):
    text = accepted.manifest(state, workspace, status=status)
    text = text.replace('root = "/work-context"', 'root = '+json.dumps(str(context)))
    text = text.replace('root = "/model-tool-fixture"', 'root = '+json.dumps(str(context)))
    if not status:
        profile = tomllib.loads(text)['runtime']['profiles']['harness-work']
        assert profile['model']['base_url'] == 'http://127.0.0.1:'+str(PORT)+'/v1'
        assert profile['model']['model'] == MODEL and profile['model']['api_key_env'] == 'NOMO_HARNESS_EDIT_TEST_KEY'
        assert profile['model']['retry'] == dict(attempts=1, delay_ms=0)
        assert profile['memory'] == dict(backend='sqlite', path=str(state/'edit.sqlite3'))
        regions = profile['filesystem']['regions']
        assert regions[edit.REGION] == dict(root=str(workspace), read=True, write=True, delete=False)
        assert regions[cases.READ_REGION]['root'] == str(context) and regions[cases.READ_REGION]['read'] and not regions[cases.READ_REGION]['write']
    return text


def reply(item, context, ordinal):
    if ordinal == 0: return item.get('read_plan_raw', cases.encoded(['delegate', item['read_task']]))
    if ordinal == 1: return item.get('read_action_raw', cases.encoded(cases.action(item)))
    if ordinal == 2:
        observed = [event['text'] for event in context['history'] if event['role'] == 'tool' and event['kind'] == 'complete']
        assert len(observed) == 1
        return item.get('read_final_raw', cases.encoded(['final', 'Seen: '+observed[0]]))
    if ordinal == 3: return 'Summary: '+context['outcome']
    value = cases.selected_value(context['evidence']['operation'], context['evidence']['outcome'])
    if ordinal == 4: return cases.encoded(['delegate', 'replace selected with '+value])
    if ordinal == 5:
        original = context['edit']['before']; target = 'old' if 'old' in original else original
        replacement = ('\x02' if value == 'blue' else '\x03')*2048 if item.get('boundary') else value
        return item.get('edit_child_raw', cases.encoded(['edit', target, replacement]))
    return cases.final_answer(context)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0')); raw = self.rfile.read(size) if 0 < size <= 196608 else b''
        record = dict(request_base64=base64.b64encode(raw).decode(), finished=threading.Event())
        with self.server.lock:
            ordinal = len(self.server.records); self.server.records.append(record)
        try:
            assert self.path == '/v1/chat/completions' and self.headers.get('Authorization') == 'Bearer '+TOKEN
            request = json.loads(raw); context = json.loads(request['messages'][1]['content'])
            phase = cases.ORDER[ordinal]; item = self.server.item
            record.update(phase=phase, request=request, context=context, journal_at_request=edit.rows(self.server.state))
            text = reply(item, context, ordinal)
            mode = item.get('fail_mode', 'ok') if item.get('fail_phase') == phase else 'ok'
            prompt = item.get('edit_usage_prompt', 10) if ordinal >= 4 else 10
            usage = dict(prompt_tokens=prompt, completion_tokens=4, total_tokens=prompt+4)
            if mode == 'token_overrun':
                spent = sum(prior['response_usage']['total_tokens'] for prior in self.server.records[:-1])
                prompt = cases.NATIVE[ordinal]-spent
                usage = dict(prompt_tokens=prompt, completion_tokens=1, total_tokens=prompt+1)
                assert usage['total_tokens'] <= cases.NATIVE[ordinal] and spent+usage['total_tokens'] == cases.NATIVE[ordinal]+1
            body = dict(choices=[dict(message=dict(role='assistant', content=text), finish_reason='stop')], usage=usage)
            code = 200
            if mode == 'unavailable': code, body = 503, dict(error=dict(message='owned final summary fixture unavailable'))
            data = cases.encoded(body).encode()
            record.update(response_status=code, response_text=text, response_usage=usage, fixture_mode=mode,
                          response_base64=base64.b64encode(data).decode())
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers()
            try: self.wfile.write(data); record['response_write'] = 'completed'
            except (BrokenPipeError, ConnectionResetError): record['response_write'] = 'client already aborted'
        except Exception as error:
            record['observer_error'] = repr(error)
            try: self.send_error(500, 'owned observation failed')
            except (BrokenPipeError, ConnectionResetError): pass
        finally: record['finished'].set()


def assert_http(item, records, binding):
    assert len(records) == item['calls']
    for ordinal, record in enumerate(records):
        assert 'observer_error' not in record, record
        request = record['request']
        assert request['model'] == MODEL and request['max_tokens'] == cases.OUTPUT[ordinal]
        assert request['chat_template_kwargs'] == dict(enable_thinking=False)
        assert [message['role'] for message in request['messages']] == ['system', 'user']
        maximum = 2048 if ordinal < 4 else 65536
        assert len(request['messages'][1]['content'].encode()) <= maximum
        assert record['context'] == cases.context(item, ordinal, binding), 'exact native read/evidence/edit context differs'
        if ordinal == 6:
            assert record['journal_at_request']['operation']['value'] == dict(format=1, phase='completed', binding=binding)
            assert record['journal_at_request']['operation']['version'] == 2
        else: assert record['journal_at_request'] == {}


def assert_trace(item, trace):
    events = trace['events']; started = [event for event in events if event['kind'] == 'host_request_started']
    observed = [event['qualified_action'] for event in started]
    assert all(model_action(action) or action in {'Policy.evaluate', 'Memory.read', 'Memory.write', 'Approval.request',
               'Console.stdout_write', 'Console.stdin_read_line', 'Fs.stat', 'Fs.read', 'Fs.atomic_replace'} for action in observed)
    models = [event for event in started if model_action(event['qualified_action'])]
    atomics = [event for event in started if event['qualified_action'] == 'Fs.atomic_replace']
    writes = [event for event in started if event['qualified_action'] == 'Memory.write']
    assert len(models) == item['calls'] and len(atomics) == item['atomic']
    assert next(action for action in observed if action != 'Policy.evaluate') == 'Memory.read'
    assert observed.count('Fs.read') == item['read_reads']+item['edit_reads'] and observed.count('Fs.stat') == item['edit_reads']
    assert len(writes) == (2 if item['phase'] == 'completed' or item['kind'] == 'completion_error' else 1 if item['phase'] == 'intent' else 0)
    position = {(event['kind'], event['id']): n for n, event in enumerate(events) if event['kind'] in ['host_request_started', 'host_request_finished']}
    by_id = {event['id']: event['qualified_action'] for event in started}
    if atomics:
        start, end = position['host_request_finished', writes[0]['id']], position['host_request_started', atomics[0]['id']]
        assert start < end and any(event['kind'] == 'host_request_finished' and by_id[event['id']] == 'Memory.read' for event in events[start+1:end])
    if item['aggregate']:
        start, end = position['host_request_finished', writes[1]['id']], position['host_request_started', models[-1]['id']]
        assert start < end and any(event['kind'] == 'host_request_finished' and by_id[event['id']] == 'Memory.read' for event in events[start+1:end])
    if item['kind'] in ['non_tty', 'native_no']: assert 'Console.stdin_read_line' not in observed
    return observed


def run_case(cli, evidence, item):
    folder = evidence/item['name']; state = folder/'state'; workspace = folder/'workspace'; context = folder/'context'
    for path in [state, workspace, context]: path.mkdir(parents=True, mode=0o700)
    (workspace/item['path']).write_bytes(item['before'].encode()); (workspace/item['path']).chmod(0o600)
    for name, text in item['context_files'].items():
        target = context/name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(text); target.chmod(0o600)
    context_before = {name: (context/name).read_bytes() for name in item['context_files']}
    for label, readonly in [('project', False), ('status-project', True)]:
        project = folder/label; shutil.copytree(ROOT/'src', project/'src'); shutil.copyfile(ROOT/'etas.lock', project/'etas.lock')
        (project/'etas.toml').write_text(manifest(state, workspace, context, status=readonly))
    selectors = ['--id', item['id'], '--workspace', item['workspace'], '--path', item['path']]
    argv = [str(cli), 'run', str(folder/'project'), '--flow', 'harness_work', '--allow-effects', '--trace-out', str(folder/'apply.trace.json'),
            '--args', *selectors, '--once', item['request'], '--allow', ','.join(item['allowed'])]
    profile = subprocess.run([str(cli), 'run', str(folder/'project'), '--flow', 'harness_work', '--print-runtime-profile'], cwd=state, env=environment(), capture_output=True, timeout=15)
    (folder/'profile.stdout.bin').write_bytes(profile.stdout); (folder/'profile.stderr.bin').write_bytes(profile.stderr)
    assert profile.returncode == 0 and not profile.stderr
    effective = json.loads(profile.stdout); assert effective['profile'] == 'harness-work' and effective['approval'] == 'Prompt'
    assert effective['memory'] == dict(kind='sqlite', path=str(state/'edit.sqlite3'))
    regions = {region['identity']: region for region in effective['filesystem_regions']}
    assert regions == {edit.REGION: dict(identity=edit.REGION, root=str(workspace), read=True, write=True, delete=False),
                       cases.READ_REGION: dict(identity=cases.READ_REGION, root=str(context), read=True, write=False, delete=False)}
    binding, preview = edit.expected(item)
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler); server.daemon_threads = True
    server.item, server.state, server.records, server.lock = item, state, [], threading.Lock()
    thread = threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=0.01), daemon=True); thread.start()
    record = dict(name=item['name'], item=item, argv=argv, effective_profile=effective, status='running')
    try:
        if item['kind'] == 'non_tty':
            proc = subprocess.Popen(argv, cwd=state, env=environment(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try: proc.wait(timeout=30); out, err, code = proc.stdout.read(), proc.stderr.read(), proc.returncode
            finally:
                if proc.poll() is None: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
                proc.stdin.close(); proc.stdout.close(); proc.stderr.close()
            milestones = ['open_pipe_terminated']
        else: out, err, code, milestones = edit.run_pty(argv, state, item, workspace, binding)
        (folder/'apply.stdout.bin').write_bytes(out); (folder/'apply.stderr.bin').write_bytes(err)
        record.update(exit=code, stdout=out.decode(), stderr=err.decode(), milestones=milestones)
        assert (code == 0) == item['exit_zero'] and (preview.encode() in out) == item['preview']
        assert all(byte == 10 or 32 <= byte <= 126 for byte in out)
        journal = edit.rows(state); current = (workspace/item['path']).read_bytes()
        assert (b'APPLIED '+item['id'].encode() in out) == (item['phase'] == 'completed')
        if journal: assert journal['operation']['value'] == dict(format=1, phase=item['phase'], binding=binding)
        else: assert item['phase'] == 'empty'
        assert current == (b'external change' if item['kind'] == 'mismatch' else item['after'].encode() if item['changed'] else item['before'].encode())
        final = [line[len(b'FINAL '):] for line in out.splitlines() if line.startswith(b'FINAL ')]
        assert bool(final) == item['exit_zero']
        if final: assert len(final) == 1 and json.loads(final[0]) == [cases.final_answer(cases.context(item, 6, binding))]
        if item['phase'] == 'completed' and not item['exit_zero']:
            after_applied = out.split(b'APPLIED ', 1)[1].lower(); assert b'completed' in after_applied and b'edit_status' in after_applied
            assert b'unmodified' not in after_applied and b'not applied' not in after_applied
        assert err.count(b'Type `yes` to approve:') == (1 if item['preview'] and item['kind'] != 'non_tty' else 0)
        record['actions'] = assert_trace(item, json.loads((folder/'apply.trace.json').read_text()))
        assert_http(item, server.records, binding)
        before = edit.previous.inspect(state); (folder/'status.before.json').write_text(json.dumps(before, indent=2)+'\n')
        status_argv = [str(cli), 'run', str(folder/'status-project'), '--flow', 'edit_status', '--allow-effects', '--trace-out', str(folder/'status.trace.json'), '--args', *selectors]
        shown = subprocess.run(status_argv, cwd=state, env=environment(False), input=b'', capture_output=True, timeout=20)
        (folder/'status.stdout.bin').write_bytes(shown.stdout); (folder/'status.stderr.bin').write_bytes(shown.stderr)
        after = edit.previous.inspect(state); (folder/'status.after.json').write_text(json.dumps(after, indent=2)+'\n')
        assert shown.returncode == 0 and not shown.stderr and before == after
        stored = json.loads(shown.stdout.decode().splitlines()[0][len('OPERATION '):]); assert stored['phase'] == item['phase']
        if journal: assert stored == dict(format='nomo-edit-operation-v1', phase=item['phase'], **{key: str(value) for key, value in binding.items()})
        status_actions = actions(json.loads((folder/'status.trace.json').read_text()))
        assert set(status_actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'} and status_actions.count('Memory.read') == (2 if journal else 1)
        retries = []
        if journal:
            for opid in [item['id'], 'different-id']:
                retry = list(argv); retry[retry.index('--id')+1] = opid; retry[retry.index('--trace-out')+1] = str(folder/('retry-'+opid+'.trace.json'))
                refused = subprocess.run(retry, cwd=state, env=environment(), input=b'', capture_output=True, timeout=20)
                (folder/('retry-'+opid+'.stdout.bin')).write_bytes(refused.stdout); (folder/('retry-'+opid+'.stderr.bin')).write_bytes(refused.stderr)
                observed = actions(json.loads(Path(retry[retry.index('--trace-out')+1]).read_text()))
                assert refused.returncode != 0 and b'edit operation slot already consumed; no retry' in refused.stdout
                assert set(observed) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'} and observed.count('Memory.read') == 1
                retries.append(dict(id=opid, argv=retry, exit=refused.returncode, actions=observed))
            assert edit.previous.inspect(state) == after and (workspace/item['path']).read_bytes() == current
        assert len(server.records) == item['calls'] and context_before == {name: (context/name).read_bytes() for name in item['context_files']}
        record.update(status='passed', journal=journal, status_argv=status_argv, status_actions=status_actions, retries=retries)
        return record
    except BaseException as error:
        record.update(status='failed', failure=repr(error)); raise
    finally:
        server.shutdown(); thread.join(timeout=2)
        for request in server.records: request['finished'].wait(2)
        server.server_close()
        requests = [{key: value for key, value in request.items() if key != 'finished'} for request in server.records]
        (folder/'http.json').write_text(json.dumps(requests, indent=2)+'\n'); (folder/'observation.json').write_text(json.dumps(record, indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--suite', choices=['smoke', 'matrix', 'pair', 'all'], default='smoke'); parser.add_argument('--case', action='append', dest='names')
    parser.add_argument('--prepare-only', action='store_true'); options = parser.parse_args()
    selected = cases.selected(options.suite)
    if options.names:
        selected = [item for item in cases.cases() if item['name'] in options.names]; assert set(options.names) == {item['name'] for item in selected}
    options.evidence_dir.mkdir(parents=True, exist_ok=True); evidence = Path(tempfile.mkdtemp(prefix='harness-work-', dir=options.evidence_dir))
    (evidence/'cases.json').write_text(json.dumps(selected, indent=2)+'\n'); print('EVIDENCE '+str(evidence), flush=True)
    if options.prepare_only: return
    result = dict(task='HARNESS-WORK-001A', status='running', suite=options.suite, cases=[])
    save = lambda: (evidence/'results.json').write_text(json.dumps(result, indent=2)+'\n'); save()
    try:
        assert os.getuid() == 10001; cli = verify_cli()
        for item in selected:
            result['cases'].append(run_case(cli, evidence, item)); save(); print('PASS '+item['name'], flush=True)
        result['status'] = 'passed'
    except BaseException as error: result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'] = {name: (Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.max']}
        r = result['resources']; events = dict(line.split() for line in r['memory.events'].splitlines())
        valid = r['memory.max'] == '4294967296' and r['cpu.max'] == '400000 100000' and r['pids.max'] == '256' and all(events[key] == '0' for key in ['max', 'oom', 'oom_kill', 'oom_group_kill'])
        if not valid: result.update(status='failed', resource_failure='ordinary resource guard failed')
        save(); assert valid


if __name__ == '__main__': main()
