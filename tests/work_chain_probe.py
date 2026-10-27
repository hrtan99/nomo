#!/usr/bin/env python3
"""Actual two-turn v2 work chain with owned Model/PTY/SQLite fixtures.

Only this observer emits protocol replies and constructs explicit corrupt test
copies. The actual frozen Etas entry performs admission, confirmation, editing,
publication and read-only show. No observer result substitutes for a receipt.
"""
import argparse
import base64
from copy import deepcopy
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import tomllib

import harness_work_probe as work
import harness_work_session_probe as saved
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
CHAIN = 'nomo-work-chain-v2'
JOURNAL = 'nomo-work-chain-edit-v2'
CAP_KEYS = ['steps', 'calls', 'generation', 'native_tokens', 'read_tools', 'scan', 'edit_reads', 'edit_read_bytes', 'atomic', 'atomic_bytes']
TURN = dict(zip(CAP_KEYS, [13, 7, 47104, 196608, 1, 4096, 3, 6144, 1, 2048]))
LIFETIME = {key: value*2 for key, value in TURN.items()}
ZERO = dict.fromkeys(CAP_KEYS, 0)
TAIL = dict(ZERO, steps=1, calls=1, generation=2048, native_tokens=65536)
ORIGINAL_ROWS = saved.all_rows
ACTIVE_TURN = 1


def untag(value):
    kind = value['kind']
    if kind == 'record': return {field['name']: untag(field['value']) for field in value['fields']}
    if kind in ['array', 'list']: return [untag(item) for item in value['items']]
    if kind in ['int', 'uint']: return int(value['value'])
    if kind in ['string', 'bool', 'json']: return value['value']
    if kind == 'variant':
        if value['name'] == 'None' and value['fields'] == []: return None
        if value['name'] == 'Some' and len(value['fields']) == 1 and 'kind' in value['fields'][0]: return untag(value['fields'][0])
        raise AssertionError('unsupported actual SQL variant shape '+repr(value))
    # Any newly encountered persistence representation is retained in raw SQL
    # and fails explicitly, instead of assuming a null/Some encoding.
    raise AssertionError('unsupported actual SQL value kind '+repr(kind))


def rows(state, snapshot=None):
    database = state/'edit.sqlite3'
    if not database.exists(): return {}
    with closing(sqlite3.connect(database.as_uri()+'?mode=ro', uri=True)) as connection:
        if not connection.execute("SELECT name FROM sqlite_master WHERE name='memory_entries'").fetchall(): return {}
        values = connection.execute('SELECT region,path,key_json,value_json,version FROM memory_entries ORDER BY region,key_json').fetchall()
        if snapshot is not None:
            snapshot['sql_snapshot'] = dict(database_uri=database.as_uri()+'?mode=ro',
                database_list=connection.execute('PRAGMA database_list').fetchall(),
                journal_mode=connection.execute('PRAGMA journal_mode').fetchone()[0],
                in_transaction=connection.in_transaction,
                selected_keys=[dict(region=value[0],key_json=value[2],version=value[4]) for value in values],
                reader_lifecycle='fresh read-only connection explicitly closed before decoding')
    result = {}
    for region, path, key, value, version in values:
        name = untag(json.loads(key)); selected = result.setdefault(region, {})
        assert name not in selected
        selected[name] = dict(region=region, path=json.loads(path), key_json=key, value_json=value,
                              value=untag(json.loads(value)), version=version)
    return result


def journal_projection(state):
    current = rows(state).get(JOURNAL, {}).get('turn:'+str(ACTIVE_TURN))
    if current is None: return {}
    value = current['value']
    return {'operation': dict(current, value=dict(format=1, phase=value['phase'], binding=value['binding']))}


# Reuse the accepted PTY driver without weakening its per-current-operation
# assertions. Lifecycle admission and previous-turn journal are checked by the
# independent SQL observations below, not hidden from those observations.
work.edit.rows = journal_projection


def inner(row):
    value = row['work']
    if value is None: return None
    if isinstance(value, dict) and set(value) == {'Some'}: return value['Some']
    return value


def process(folder, label, argv, state, env):
    observed = subprocess.run(list(map(str, argv)), cwd=state, env=env, input=b'', capture_output=True, timeout=45)
    (folder/(label+'.stdout.bin')).write_bytes(observed.stdout)
    (folder/(label+'.stderr.bin')).write_bytes(observed.stderr)
    return observed


def profile_project(folder, state, workspace, context, name, readonly=False):
    destination = folder/name
    shutil.copytree(ROOT/'src', destination/'src')
    shutil.copyfile(ROOT/'etas.lock', destination/'etas.lock')
    text = work.manifest(state, workspace, context, status=readonly)
    (destination/'etas.toml').write_text(text)
    selected = tomllib.loads(text)['runtime']['profiles']['work-chain-show' if readonly else 'work-chain']
    assert selected['memory']['backend'] == 'sqlite'
    if readonly:
        assert not any(key in selected for key in ['model', 'filesystem', 'approval'])
        assert selected['policy']['rules'] == ['console=allow', 'memory:Memory.read=allow', 'memory:Memory.write=deny']
    else:
        assert selected['model']['base_url'] == 'http://127.0.0.1:'+str(work.PORT)+'/v1'
        assert selected['model']['api_key_env'] == 'NOMO_HARNESS_EDIT_TEST_KEY'
        assert selected['model']['retry'] == dict(attempts=1, delay_ms=0)
    return destination


def item(name, *, turn=1, selection='blue', path='note.txt', allowed=None, **changes):
    allowed = ['context.txt'] if allowed is None else allowed
    value = work.cases.case(name, id='root-work' if turn == 1 else 'child-work', path=path,
                            allowed=allowed, context_files={allowed[0]: selection})
    before = 'old\n' if turn == 1 else 'base\n'
    replacement = 'base' if turn == 1 else selection
    value.update(turn=turn, before=before, target='old' if turn == 1 else 'base', replacement=replacement,
                 task='replace selected with '+replacement, after=before.replace('old' if turn == 1 else 'base', replacement),
                 final_summary='Captured '+selection+' after '+replacement)
    value.update(changes)
    return value


def parent_facts(parent):
    record = inner(parent); assert record is not None
    fields = json.loads(record['body'])
    return [dict(chain=parent['chain'], root=parent['chain'], id=parent['id'], turn=parent['turn'], after_digest=record['binding']['after_digest'],
                 request=fields[11], read_task=fields[12], operation=fields[13], files=[fields[16]]+([fields[17]] if fields[17] else []),
                 literal=fields[18], outcome=fields[19], result=fields[20], read_summary=fields[21], final_summary=fields[27])]


def expected_context(selected, ordinal, binding, prior):
    current = work.cases.context(selected, ordinal, binding)
    return current if ordinal < 4 else dict(current=current, parent=prior)


def reply(selected, context, ordinal):
    if ordinal < 4: return work.reply(selected, context, ordinal)
    current = context['current']
    if context['parent']:
        previous = context['parent'][0]
        selection = work.cases.selected_value(previous['operation'], previous['outcome'])
        replacement = selection
    else:
        selection = work.cases.selected_value(current['evidence']['operation'], current['evidence']['outcome'])
        replacement = 'base'
    task = 'replace selected with '+replacement
    assert replacement == selected['replacement'] and task == selected['task']
    if ordinal == 4: return work.cases.encoded(['delegate', task])
    if ordinal == 5: return work.cases.encoded(['edit', selected['target'], replacement])
    assert current['edit']['completed']
    return selected.get('summary_raw', 'Captured '+selection+' after '+replacement)


def trigger(state, phase):
    # Only an outer native string matches the unescaped quote spelling. The
    # encoded work body has escaped quotes and cannot select this trigger.
    sql = "CREATE TRIGGER chain_test_refusal BEFORE UPDATE ON memory_entries WHEN NEW.region='"+CHAIN+"' AND instr(NEW.value_json, '\""+phase+"\"')>0 BEGIN SELECT RAISE(ABORT,'owned chain lifecycle refusal'); END"
    with sqlite3.connect(state/'edit.sqlite3') as connection: connection.execute(sql)
    return sql


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(size) if 0 < size <= 262144 else b''
        record = dict(request_base64=base64.b64encode(raw).decode(), finished=threading.Event())
        with self.server.lock:
            ordinal = len(self.server.records); self.server.records.append(record)
        try:
            assert self.path == '/v1/chat/completions' and self.headers.get('Authorization') == 'Bearer '+work.TOKEN
            request = json.loads(raw); context = json.loads(request['messages'][1]['content'])
            observed = rows(self.server.state, record); selected = self.server.item
            record.update(request=request, context=context, ordinal=ordinal, rows_at_request=deepcopy(observed))
            row = observed[CHAIN]['turn:'+str(selected['turn'])]['value']
            if ordinal == 0:
                assert row['phase'] == 'admitted' and row['reserved'] == TURN
                assert row['remaining'] == (TURN if selected['turn'] == 1 else ZERO)
                assert 'turn:'+str(selected['turn']) not in observed.get(JOURNAL, {})
            if ordinal == 6:
                assert row['phase'] == 'summary-unconfirmed' and row['reserved'] == TAIL
                assert observed[JOURNAL]['turn:'+str(selected['turn'])]['value']['phase'] == 'completed'
                self.server.partial = deepcopy(observed[CHAIN]['turn:'+str(selected['turn'])])
            text = reply(selected, context, ordinal)
            code = 503 if ordinal == 6 and selected.get('summary_failure') else 200
            body = dict(error=dict(message='owned chain summary unavailable')) if code == 503 else dict(
                choices=[dict(message=dict(role='assistant', content=text), finish_reason='stop')],
                usage=dict(prompt_tokens=10, completion_tokens=4, total_tokens=14))
            data = work.cases.encoded(body).encode()
            record.update(response_status=code, response_text=text, response_base64=base64.b64encode(data).decode())
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers()
            try: self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError): record['response_write'] = 'client aborted'
        except BaseException as error:
            record['observer_error'] = repr(error)
            try: self.send_error(500, 'owned chain observation failed')
            except (BrokenPipeError, ConnectionResetError): pass
        finally: record['finished'].set()


def assert_http(selected, requests, binding, prior):
    assert len(requests) == selected.get('calls', 7), 'Model attempt count differs'
    for ordinal, observed in enumerate(requests):
        assert 'observer_error' not in observed, 'HTTP observer software bug: '+str(observed.get('observer_error'))
        request = observed['request']
        assert request['model'] == work.MODEL and request['max_tokens'] == work.cases.OUTPUT[ordinal]
        assert request['chat_template_kwargs'] == dict(enable_thinking=False)
        assert [message['role'] for message in request['messages']] == ['system', 'user']
        assert observed['context'] == expected_context(selected, ordinal, binding, prior), 'exact restored/current typed context differs'
        assert len(request['messages'][1]['content'].encode()) <= (2048 if ordinal < 4 else 81920)
        if ordinal >= 4:
            assert len(work.cases.encoded(observed['context']['parent']).encode()) <= 8192
            assert all('body' not in parent and 'before' not in parent and 'after' not in parent for parent in observed['context']['parent'])


def assert_record(selected, row, phase, binding):
    assert row['format'] == 2 and row['phase'] == phase and row['turn'] == selected['turn'] and row['id'] == selected['id']
    assert row['workspace'] == selected['workspace'] and row['path'] == selected['path'] and row['request'] == selected['request']
    assert row['allowed'] == selected['allowed'] and row['region'] == work.edit.REGION
    assert row['maximum'] == LIFETIME and row['available'] == TURN
    assert row['remaining'] == (TURN if selected['turn'] == 1 else ZERO)
    assert row['reserved'] == (ZERO if phase == 'summary-confirmed' else TAIL if phase == 'summary-unconfirmed' else TURN)
    record = inner(row)
    if phase == 'admitted': assert record is None
    else:
        assert record['binding'] == binding
        summary = selected.get('summary_raw', selected['final_summary']) if phase == 'summary-confirmed' else ''
        assert json.loads(record['body']) == saved.body_fields(selected, binding, phase, summary)
        assert record['phase'] == phase and record['format'] == 1


def trace_actions(folder, label):
    path = folder/(label+'.trace.json')
    assert path.exists(), 'missing actual trace '+str(path)
    return work.actions(json.loads(path.read_text()))


def show(cli, folder, state, selected, phase, journal_phase='completed'):
    selectors = ['--id', selected['id'], '--workspace', selected['workspace'], '--path', selected['path']]
    argv = [cli, 'run', folder/'show-project', '--flow', 'chain_show', '--profile', 'work-chain-show', '--allow-effects', '--trace-out', folder/'show.trace.json', '--args', *selectors]
    actual_row = rows(state)[CHAIN]['turn:'+str(selected['turn'])]['value']
    before = work.edit.previous.inspect(state)
    observed = process(folder, 'show', argv, state, saved.provider_free_environment())
    assert observed.returncode == 0 and not observed.stderr
    assert work.edit.previous.inspect(state) == before, 'show changed logical SQLite state'
    actions = trace_actions(folder, 'show')
    assert set(actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'}
    assert all(byte == 10 or 32 <= byte <= 126 for byte in observed.stdout)
    groups = {}
    for line in observed.stdout.decode().splitlines():
        name, _, data = line.partition(' ')
        if data.startswith('{'):
            # The accepted work display and v2 lifecycle both use RESERVATION;
            # retain all groups instead of overwriting one with the other.
            groups.setdefault(name, []).append(json.loads(data))
    assert groups['CHAIN'] == [dict(format='2', phase=phase, chain='root-work', id=selected['id'], turn=str(selected['turn']),
        workspace=selected['workspace'], region=work.edit.REGION, path=selected['path'], parent_id='' if selected['turn']==1 else 'root-work',
        parent_version=actual_row['parent_version'], parent_digest=actual_row['parent_digest'], request=selected['request'])]
    for name, expected in [('ALLOWANCE', LIFETIME), ('AVAILABLE', TURN), ('REMAINING', TURN if selected['turn']==1 else ZERO)]:
        assert groups[name] == [{key: str(value) for key, value in expected.items()}]
    expected_reservation = ZERO if phase == 'summary-confirmed' else TAIL if phase == 'summary-unconfirmed' else TURN
    assert groups['RESERVATION'][0] == {key: str(value) for key, value in expected_reservation.items()}
    if journal_phase is not None: assert groups['JOURNAL'][0]['phase'] == journal_phase
    if phase != 'admitted':
        binding, _ = work.edit.expected(selected)
        assert groups['EDIT'][0] == dict(task=selected['task'], target=selected['target'], replacement=selected['replacement'],
            before=selected['before'], after=selected['after'], summary=selected.get('summary_raw', selected['final_summary']) if phase=='summary-confirmed' else '')
        assert groups['READ'][0]['outcome'] == work.cases.outcome(selected) and groups['WORK'][0]['request_digest'] == binding['request_digest']
    else: assert 'WORK' not in groups and b'may have an intent or completed edit' in observed.stdout
    return dict(command=list(map(str, argv)), exit=observed.returncode, actions=actions, groups=groups)


def run_turn(cli, folder, state, workspace, context, selected, parent=None):
    global ACTIVE_TURN
    ACTIVE_TURN = selected['turn']
    folder.mkdir(parents=True, exist_ok=True)
    profile_project(folder, state, workspace, context, 'project')
    profile_project(folder, state, workspace, context, 'show-project', True)
    for name, data in selected['context_files'].items():
        path = context/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(data)
    original_file = (workspace/selected['path']).read_bytes()
    assert original_file == selected['before'].encode()
    parent_before = deepcopy(rows(state).get(CHAIN, {}).get('turn:1')) if parent else None
    prior = parent_facts(parent_before['value']) if parent else []
    binding, preview = work.edit.expected(selected)
    selectors = ['--id', selected['id'], '--workspace', selected['workspace'], '--path', selected['path'], '--once', selected['request'], '--allow', ','.join(selected['allowed'])]
    if parent: selectors += ['--parent', parent]
    argv = [str(cli), 'run', str(folder/'project'), '--flow', 'chain_continue' if parent else 'chain_new', '--profile', 'work-chain', '--allow-effects', '--trace-out', str(folder/'apply.trace.json'), '--args', *selectors]
    server = ThreadingHTTPServer(('127.0.0.1', work.PORT), Handler); server.daemon_threads = True
    server.item, server.state, server.records, server.lock, server.partial = selected, state, [], threading.Lock(), None
    thread = threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=0.01), daemon=True); thread.start()
    result = dict(name=selected['name'], item=selected, command=argv, status='running')
    def preview_check(out, _item, _binding):
        assert preview.encode() in out
        admission = rows(state)[CHAIN]['turn:'+str(selected['turn'])]['value']
        assert admission['phase'] == 'admitted' and admission['reserved'] == TURN
        if selected.get('storage_failure'):
            result['trigger'] = trigger(state, 'summary-unconfirmed' if selected['storage_failure']=='partial' else 'summary-confirmed')
    try:
        out, err, code, milestones = work.edit.run_pty(argv, state, selected, workspace, binding, preview_check=preview_check,
            failure_output=lambda out, err: ((folder/'apply.stdout.bin').write_bytes(out), (folder/'apply.stderr.bin').write_bytes(err)))
        (folder/'apply.stdout.bin').write_bytes(out); (folder/'apply.stderr.bin').write_bytes(err)
        expected_success = selected.get('exit_zero', True)
        assert (code==0) == expected_success, 'entry exit differs; see '+str(folder)
        assert (b'SAVED' in out) == expected_success
        assert all(byte == 10 or 32 <= byte <= 126 for byte in out)
        observed_rows = rows(state); current = observed_rows[CHAIN]['turn:'+str(selected['turn'])]
        assert set(observed_rows) <= {CHAIN, JOURNAL}, 'v1 or unrelated namespace accessed'
        if parent:
            assert observed_rows[CHAIN]['turn:1'] == parent_before, 'continuation mutated immutable parent'
            assert current['value']['parent_id'] == parent and current['value']['parent_version']
            assert len(current['value']['parent_digest']) == 64
        phase = 'summary-confirmed' if expected_success else selected.get('stored_phase', 'summary-unconfirmed')
        assert_record(selected, current['value'], phase, binding)
        assert_http(selected, server.records, binding, prior)
        actions = trace_actions(folder, 'apply')
        assert actions.count('Fs.atomic_replace') == selected.get('atomic', 1)
        assert sum(work.model_action(action) for action in actions) == selected.get('calls', 7)
        assert actions.count('Approval.request') == (1 if selected.get('calls', 7)>=6 else 0)
        writes = 1 if not selected.get('atomic',1) else 4 if selected.get('summary_failure') or selected.get('storage_failure')=='partial' else 5
        assert actions.count('Memory.write') == writes, 'v2 admission/journal/publication attempt count differs'
        assert actions.count('Fs.stat') == (3 if selected.get('atomic',1) else 1)
        assert actions.count('Fs.read') == selected['read_reads']+(3 if selected.get('atomic',1) else 1)
        if selected.get('atomic', 1):
            assert b'APPLIED '+selected['id'].encode() in out and b'EDIT completed ' in out and b'chain_show' in out
            assert observed_rows[JOURNAL]['turn:'+str(selected['turn'])]['value'] == dict(format=2, chain='root-work', turn=selected['turn'], phase='completed', binding=binding)
        expected_file = selected['after'] if selected.get('atomic', 1) else selected['before']
        assert (workspace/selected['path']).read_bytes() == expected_file.encode()
        if selected.get('storage_failure'):
            result['storage_observation'] = 'returned_refusal' if b'REFUSED' in out else 'native_abort' if b'StorageError' in err else 'unclassified_abort'
            assert result['storage_observation'] != 'unclassified_abort'
        if phase != 'admitted':
            assert server.partial is not None
            assert_record(selected, server.partial['value'], 'summary-unconfirmed', binding)
            if expected_success: assert current['version'] != server.partial['version']
        result.update(exit=code, milestones=milestones, phase=phase, actions=actions, rows=observed_rows, prior=prior)
    except BaseException as error: result.update(status='failed', failure=repr(error)); raise
    finally:
        server.shutdown(); thread.join(timeout=2)
        for request in server.records: request['finished'].wait(2)
        server.server_close()
        result['http'] = [{key:value for key,value in request.items() if key!='finished'} for request in server.records]
        (folder/'observation.json').write_text(json.dumps(result, indent=2)+'\n')
    result['show'] = show(cli, folder, state, selected, phase, journal_phase='completed' if selected.get('atomic',1) else None)
    result['status'] = 'passed'; (folder/'observation.json').write_text(json.dumps(result, indent=2)+'\n')
    return result


def refusal(cli, folder, state, project, selected, label, *, parent=None, flow='chain_continue', extra=None):
    folder.mkdir(parents=True, exist_ok=True)
    selectors = ['--id', selected['id'], '--workspace', selected['workspace'], '--path', selected['path'], '--once', selected['request'], '--allow', ','.join(selected['allowed'])]
    if parent is not None: selectors += ['--parent', parent]
    selectors += extra or []
    argv = [cli, 'run', project, '--flow', flow, '--profile', 'work-chain', '--allow-effects', '--trace-out', folder/(label+'.trace.json'), '--args', *selectors]
    before = work.edit.previous.inspect(state)
    observed = process(folder, label, argv, state, saved.provider_free_environment())
    actions = trace_actions(folder, label)
    assert observed.returncode != 0 and b'REFUSED' in observed.stdout
    assert set(actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'}, 'refusal dispatched Model/File/Approval/write'
    assert work.edit.previous.inspect(state) == before
    return dict(label=label, command=list(map(str,argv)), exit=observed.returncode, actions=actions, stdout=observed.stdout.decode(), stderr=observed.stderr.decode())


def scenario(cli, evidence, name, selection='blue', *, failure=None, deep=False):
    folder = evidence/name; state=folder/'state'; workspace=folder/'workspace'; context=folder/'context'
    for path in [state, workspace, context]: path.mkdir(parents=True, mode=0o700)
    target = 'a/b/c/d/e/f/g/edit.txt' if deep else 'note.txt'
    allowed = ['a/b/c/d/e/f/g/input.txt'] if deep else ['context.txt']
    original = workspace/target; original.parent.mkdir(parents=True, exist_ok=True); original.write_text('old\n')
    first = item(name+'-first', selection=selection, path=target, allowed=allowed)
    if failure == 'parent_partial': first.update(summary_failure=True, exit_zero=False)
    one = run_turn(cli, folder/'first', state, workspace, context, first)
    result = dict(name=name, status='running', first=one, refusals=[])
    second = item(name+'-second', turn=2, selection=selection, path=target, allowed=allowed)
    second['context_files'] = {allowed[0]: 'blue'}  # Current read inputs stay fixed across the parent-facts pair.
    for identity in ['root-work', 'different-root']:
        result['refusals'].append(refusal(cli, folder, state, folder/'first/project', dict(first,id=identity), 'new-'+identity, flow='chain_new'))
    if failure == 'parent_partial':
        result['refusals'].append(refusal(cli, folder, state, folder/'first/project', second, 'partial-parent', parent='root-work'))
    else:
        current_cap = list(TURN.values()); current_cap[0]-=1
        result['refusals'].append(refusal(cli, folder, state, folder/'first/project', second, 'smaller-current-cap', parent='root-work', extra=['--cap', ','.join(map(str,current_cap))]))
        for label, changed, parent in [('workspace',dict(second,workspace='different-workspace'),'root-work'), ('path',dict(second,path='different.txt'),'root-work'), ('parent',second,'not-the-root')]:
            result['refusals'].append(refusal(cli, folder, state, folder/'first/project', changed, 'changed-'+label, parent=parent))
        if failure == 'summary': second.update(summary_failure=True, exit_zero=False)
        elif failure == 'partial_storage': second.update(storage_failure='partial', calls=6, exit_zero=False, stored_phase='admitted')
        elif failure == 'complete_storage': second.update(storage_failure='complete', exit_zero=False)
        elif failure == 'denial': second.update(kind='nomo_no', calls=6, atomic=0, exit_zero=False, stored_phase='admitted')
        elif failure == 'original':
            original.write_text('external\n')
            second.update(before='external\n', target='external', after=selection+'\n', calls=4, atomic=0, exit_zero=False, stored_phase='admitted')
        two = run_turn(cli, folder/'second', state, workspace, context, second, parent='root-work')
        result['second'] = two
        for identity in ['child-work', 'changed-child']:
            result['refusals'].append(refusal(cli, folder, state, folder/'second/project', dict(second,id=identity), 'retry-'+identity, parent='root-work'))
        for parent in ['root-work', 'child-work']:
            result['refusals'].append(refusal(cli, folder, state, folder/'second/project', dict(second,id='third-work'), 'third-from-'+parent, parent=parent))
    result['status']='passed'; (folder/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def pair_proof(blue, green):
    first_blue, first_green = blue['first']['rows'][CHAIN]['turn:1']['value'], green['first']['rows'][CHAIN]['turn:1']['value']
    assert inner(first_blue)['binding'] == inner(first_green)['binding']
    a,b = blue['second'],green['second']
    assert a['item']['request'] == b['item']['request'] and a['item']['before'] == b['item']['before']
    assert {key:a['item'][key] for key in ['id','workspace','path','allowed']} == {key:b['item'][key] for key in ['id','workspace','path','allowed']}
    for ordinal in range(4):
        assert a['http'][ordinal]['request'] == b['http'][ordinal]['request']
        assert a['http'][ordinal]['response_text'] == b['http'][ordinal]['response_text']
    for ordinal in range(4,7):
        assert a['http'][ordinal]['context']['parent'] != b['http'][ordinal]['context']['parent']
    assert a['item']['after'] != b['item']['after']
    return dict(status='passed', current_request_original_selectors_and_read_requests_identical=True,
                parent_facts_differ=True, successor_after_differs=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--evidence-dir',type=Path,required=True)
    parser.add_argument('--suite',choices=['smoke','pair','matrix','joint','all'],default='smoke')
    parser.add_argument('--case',action='append',dest='names'); parser.add_argument('--prepare-only',action='store_true')
    options=parser.parse_args(); options.evidence_dir.mkdir(parents=True,exist_ok=True)
    evidence=Path(tempfile.mkdtemp(prefix='work-chain-',dir=options.evidence_dir)); print('EVIDENCE '+str(evidence),flush=True)
    cases=[('two_turn_blue','blue',None), ('two_turn_green','green',None), ('second_summary_failure','blue','summary'),
           ('first_summary_partial','blue','parent_partial'), ('second_partial_storage','blue','partial_storage'),
           ('second_complete_storage','blue','complete_storage'), ('second_current_denial','blue','denial'),
           ('second_original_mismatch','blue','original')]
    if options.suite=='smoke': cases=cases[:1]
    elif options.suite=='pair': cases=cases[:2]
    elif options.suite=='matrix': cases=cases[2:]
    elif options.suite=='joint': cases=[('nested_two_turn','blue',None)]
    if options.names:
        cases=[value for value in cases if value[0] in options.names]; assert set(options.names)=={value[0] for value in cases}
    result=dict(task='WORK-CHAIN-001A',status='prepared',suite=options.suite,cases=[],pair=None)
    save=lambda:(evidence/'results.json').write_text(json.dumps(result,indent=2)+'\n');save()
    if options.prepare_only:return
    try:
        assert os.getuid()==10001; cli=verify_cli(); result['status']='running';save()
        for name,selection,failure in cases:
            result['cases'].append(scenario(cli,evidence,name,selection,failure=failure,deep=options.suite=='joint'));save();print('PASS '+name,flush=True)
        if options.suite in ['pair','all']:
            result['pair']=pair_proof(result['cases'][0],result['cases'][1]);save();print('PASS parent_facts_pair',flush=True)
        result['status']='passed'
    except BaseException as error: result.update(status='failed',failure=repr(error));raise
    finally:
        result['resources']={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max','memory.peak','memory.events','cpu.max','pids.max']}
        r=result['resources'];events=dict(line.split() for line in r['memory.events'].splitlines())
        valid=r['memory.max']=='4294967296' and r['cpu.max']=='400000 100000' and r['pids.max']=='256' and all(events[key]=='0' for key in ['max','oom','oom_kill','oom_group_kill'])
        if not valid:result.update(status='failed',resource_failure='ordinary resource guard failed')
        save();assert valid,str(evidence)


if __name__=='__main__':main()
