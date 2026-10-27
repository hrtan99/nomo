#!/usr/bin/env python3
"""Focused actual saved-work/read-only-show observations using accepted fixtures."""
import argparse
from copy import deepcopy
from http.server import ThreadingHTTPServer
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
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
REGION = 'nomo-work-record-v1'
all_rows = work.edit.rows
# The accepted PTY observer checks the edit journal alone. Keep its existing
# assertions while separately observing the independent work region below.
work.edit.rows = lambda state: {key: value for key, value in all_rows(state).items() if key == 'operation'}
original_reply = work.reply
work.reply = lambda item, context, ordinal: item['summary_raw'] if ordinal == 6 and 'summary_raw' in item else original_reply(item, context, ordinal)


def provider_free_environment():
    value = work.environment(False)
    for key in list(value):
        if key.startswith('ETAS_HOST_MODEL') or key.startswith('ETAS_HOST_OMLX') or key in ['NOMO_HARNESS_EDIT_TEST_KEY', 'NOMO_QWEN_SERVER_API_KEY', 'NOMO_GATEWAY_CLIENT_TOKEN']:
            value.pop(key)
    return value


def cases():
    values = [work.cases.case('saved_read'),
              work.cases.case('saved_search', operation='search', literal='CHOSEN', allowed=['context.txt', 'other.txt'],
                              context_files={'context.txt': 'skip\nCHOSEN\n', 'other.txt': 'CHOSEN\n'}, read_reads=2),
              work.cases.case('saved_unicode_2048', boundary=True, before='界'*682+'aa', target='界'*682+'aa',
                              summary_raw=('\x1b界'*128), edit_usage_prompt=10000),
              work.cases.case('saved_controls_2048', boundary=True, before='\x1b'*2048, target='\x1b'*2048, edit_usage_prompt=10000),
              work.cases.case('summary_native_abort', fail_phase='edit-aggregate', fail_mode='unavailable', exit_zero=False),
              work.cases.case('summary_invalid', summary_raw='   ', exit_zero=False),
              work.cases.case('partial_storage_refusal', calls=6, aggregate=False, exit_zero=False, storage_failure='INSERT'),
              work.cases.case('complete_storage_refusal', exit_zero=False, storage_failure='UPDATE'),
              work.cases.case('partial_version_changed', exit_zero=False, ticket_mutation='version'),
              work.cases.case('partial_full_value_changed', exit_zero=False, ticket_mutation='value'),
              work.cases.case('partial_readback_mismatch', calls=6, aggregate=False, exit_zero=False, readback_mutation=True)]
    return values


def body_fields(item, binding, phase, summary=''):
    evidence = work.cases.evidence(item)
    padded = lambda value: [value[0], value[1] if len(value) == 2 else '']
    fields = ['nomo-work-record-v1', phase, *[str(binding[key]) for key in ['id', 'workspace', 'region', 'path', 'request_digest',
              'before_digest', 'after_digest', 'before_bytes', 'after_bytes']], item['request'], item['read_task'], item['operation'],
              *padded(item['allowed']), *padded(item['allowed']), item['literal'], evidence['outcome'], evidence['result'],
              evidence['summary'], item['task'], item['target'], item['replacement'], item['before'], item['after'], summary,
              '7', '4', '8192', '1', '4096']
    fields += ['5', '2', '36864', '98304', '3'] if phase == 'summary-unconfirmed' else ['6', '3', '38912', '163840', '3']
    fields += ['13', '7', '47104', '196608', '1', '4096', '3', '6144', '1', '2048']
    fields += ['1', '1', '2048', '65536'] if phase == 'summary-unconfirmed' else ['0']*4
    assert len(fields) == 52
    return fields


def assert_row(item, binding, row, phase, summary=''):
    assert row['region'] == REGION and row['path'] == ['Rows']
    value = row['value']; assert set(value) == {'format', 'phase', 'binding', 'body'}
    assert value['format'] == 1 and value['phase'] == phase and value['binding'] == binding
    fields = json.loads(value['body']); assert fields == body_fields(item, binding, phase, summary), 'actual persisted semantic projection differs'
    assert len(value['body'].encode()) <= 65536 and len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) <= 131072
    assert sum(len(field.encode()) for field in fields) <= 12288 and max(len(field.encode()) for field in fields) <= 2048
    assert work.TOKEN not in value['body']
    return fields


def install_trigger(state, operation):
    sql = "CREATE TRIGGER work_test_block BEFORE " + operation + " ON memory_entries WHEN NEW.region='" + REGION + "' BEGIN SELECT RAISE(ABORT,'owned work record refusal'); END"
    with sqlite3.connect(state/'edit.sqlite3') as connection: connection.execute(sql)
    return sql


class Handler(work.Handler):
    def do_POST(self):
        if len(self.server.records) == 6:
            try:
                row = all_rows(self.server.state)['work:'+self.server.item['id']]
                self.server.partial_at_request = deepcopy(row)
                if self.server.item.get('storage_failure') == 'UPDATE': self.server.trigger = install_trigger(self.server.state, 'UPDATE')
                mutation = self.server.item.get('ticket_mutation')
                if mutation:
                    with sqlite3.connect(self.server.state/'edit.sqlite3') as connection:
                        if mutation == 'version':
                            # Deliberately invalid native Store history. The Host
                            # must reject this before the source ticket comparison;
                            # this does not exercise application version matching.
                            assert connection.execute('UPDATE memory_entries SET version=version+7 WHERE region=?', [REGION]).rowcount == 1
                        else:
                            value = connection.execute('SELECT value_json FROM memory_entries WHERE region=?', [REGION]).fetchone()[0]
                            tagged = json.loads(value); tagged_field(tagged, 'phase')['value'] = 'summary-confirmed'
                            assert connection.execute('UPDATE memory_entries SET value_json=? WHERE region=?',
                                                      [json.dumps(tagged, separators=(',', ':')), REGION]).rowcount == 1
            except BaseException as error:
                self.server.preflight_error = repr(error)
        super().do_POST()


def retain_process(folder, name, argv, state, environment):
    result = subprocess.run(argv, cwd=state, env=environment, input=b'', capture_output=True, timeout=40)
    (folder/(name+'.stdout.bin')).write_bytes(result.stdout); (folder/(name+'.stderr.bin')).write_bytes(result.stderr)
    return result


def show_oracle(item, binding, phase, summary):
    evidence = work.cases.evidence(item); remaining = ['1', '1', '2048', '65536'] if phase == 'summary-unconfirmed' else ['0']*4
    return dict(WORK=dict(format='nomo-work-record-v1', phase=phase, **{key: str(value) for key, value in binding.items()}),
                READ=dict(request=item['request'], task=item['read_task'], operation=item['operation'], allowed1=item['allowed'][0],
                          allowed2=item['allowed'][1] if len(item['allowed']) == 2 else '', selected1=item['allowed'][0],
                          selected2=item['allowed'][1] if len(item['allowed']) == 2 else '', literal=item['literal'], outcome=evidence['outcome'],
                          result=evidence['result'], summary=evidence['summary']),
                EDIT=dict(task=item['task'], target=item['target'], replacement=item['replacement'], before=item['before'], after=item['after'], summary=summary),
                READ_LEDGER=dict(zip(['steps', 'calls', 'generation', 'tools', 'scan'], ['7', '4', '8192', '1', '4096'])),
                EDIT_LEDGER=dict(zip(['steps', 'calls', 'generation', 'native_tokens', 'boundaries'],
                                    ['5', '2', '36864', '98304', '3'] if phase == 'summary-unconfirmed' else ['6', '3', '38912', '163840', '3'])),
                MAXIMA=dict(zip(['steps', 'calls', 'generation', 'native_tokens', 'read_tools', 'scan', 'edit_reads', 'edit_read_bytes', 'atomic_attempts', 'edit_bytes'],
                                ['13', '7', '47104', '196608', '1', '4096', '3', '6144', '1', '2048'])),
                RESERVATION=dict(zip(['steps', 'calls', 'generation', 'native_tokens'], remaining)))


def show(cli, folder, state, item, *, success=True, phase=None, summary='', label='show', allow_native_history_trace_missing=False):
    selectors = ['--id', item['id'], '--workspace', item['workspace'], '--path', item['path']]
    argv = [str(cli), 'run', str(folder/'show-project'), '--flow', 'work_show', '--allow-effects', '--trace-out', str(folder/(label+'.trace.json')), '--args', *selectors]
    before = work.edit.previous.inspect(state)
    result = retain_process(folder, label, argv, state, provider_free_environment())
    after = work.edit.previous.inspect(state); assert before == after, 'work_show changed logical store state'
    if allow_native_history_trace_missing:
        # The new process rejects native metadata while opening the backend,
        # before entering work_show or dispatching Memory.read.
        assert not success and result.returncode != 0 and not result.stdout
        assert b'failed to open SQLite memory backend' in result.stderr
        assert b': invalid memory Store revision metadata' in result.stderr
    trace_path = folder/(label+'.trace.json')
    if trace_path.exists():
        observed = work.actions(json.loads(trace_path.read_text()))
        assert set(observed) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'}
    else:
        assert allow_native_history_trace_missing and not success
        assert result.returncode != 0
        observed = None
    assert (result.returncode == 0) == success
    assert all(byte == 10 or 32 <= byte <= 126 for byte in result.stdout), 'work_show emitted raw terminal data'
    parsed = {}
    for line in result.stdout.decode().splitlines():
        prefix, _, value = line.partition(' ')
        if prefix in ['WORK', 'READ', 'EDIT', 'READ_LEDGER', 'EDIT_LEDGER', 'MAXIMA', 'RESERVATION'] and value.startswith('{'):
            assert prefix not in parsed; parsed[prefix] = json.loads(value)
    if success and phase is not None:
        assert not result.stderr and observed.count('Memory.read') == 4
        binding, _ = work.edit.expected(item); assert parsed == show_oracle(item, binding, phase, summary)
    elif not success: assert not parsed, 'corrupt record exposed captured facts'
    else:
        assert not result.stderr and not parsed and observed.count('Memory.read') == 1
        assert b'missing' in result.stdout and b'no edit occurred' in result.stdout
    observation = dict(argv=argv, exit=result.returncode, actions=observed, stdout=result.stdout.decode(), stderr=result.stderr.decode())
    if observed is None:
        observation['trace_unavailable'] = 'native SQLite backend startup refused invalid Store revision metadata without a CLI trace artifact; work_show entry and its effects were not exercised; provider-free profile/source effects were independently verified'
    if allow_native_history_trace_missing:
        observation['entry_execution'] = 'actual not exercised: SQLite backend startup rejected invalid Store revision metadata before work_show or Memory.read'
    return observation


def project(folder, state, workspace, context, name, readonly=False):
    destination = folder/name
    shutil.copytree(ROOT/'src', destination/'src'); shutil.copyfile(ROOT/'etas.lock', destination/'etas.lock')
    text = work.manifest(state, workspace, context, status=readonly)
    (destination/'etas.toml').write_text(text)
    profile = tomllib.loads(text)['runtime']['profiles']['harness-work-show' if readonly else 'harness-work-save']
    if readonly:
        assert not any(key in profile for key in ['model', 'filesystem', 'approval'])
        assert profile['policy']['rules'] == ['console=allow', 'memory:Memory.read=allow', 'memory:Memory.write=deny']
    return destination


def assert_save_trace(trace, item):
    events = trace['events']; started = [event for event in events if event['kind'] == 'host_request_started']
    actions = [event['qualified_action'] for event in started]
    models = [event for event in started if work.model_action(event['qualified_action'])]
    writes = [event for event in started if event['qualified_action'] == 'Memory.write']
    assert len(models) == item['calls'] and actions.count('Fs.atomic_replace') == 1
    assert actions.count('Fs.read') == item['read_reads']+3 and actions.count('Fs.stat') == 3
    assert len(writes) == (3 if item.get('storage_failure') == 'INSERT' or item.get('ticket_mutation') or item.get('readback_mutation') or item['name'] in ['summary_native_abort', 'summary_invalid'] else 4)
    positions = {(event['kind'], event['id']): index for index, event in enumerate(events) if event['kind'] in ['host_request_started', 'host_request_finished']}
    assert positions['host_request_finished', writes[1]['id']] < positions['host_request_started', writes[2]['id']]
    if item['calls'] == 7:
        begin = positions['host_request_finished', writes[2]['id']]; end = positions['host_request_started', models[-1]['id']]
        assert begin < end
        assert any(event['kind'] == 'host_request_started' and event.get('qualified_action') == 'Memory.read' for event in events[begin+1:end])
        if len(writes) == 4: assert positions['host_request_finished', models[-1]['id']] < positions['host_request_started', writes[3]['id']]
    return actions


def run_case(cli, evidence, item):
    folder = evidence/item['name']; state = folder/'state'; workspace = folder/'workspace'; context = folder/'context'
    for path in [state, workspace, context]: path.mkdir(parents=True, mode=0o700)
    (workspace/item['path']).parent.mkdir(parents=True, exist_ok=True)
    (workspace/item['path']).write_bytes(item['before'].encode())
    for name, value in item['context_files'].items():
        (context/name).parent.mkdir(parents=True, exist_ok=True)
        (context/name).write_text(value)
    context_before = {name: (context/name).read_bytes() for name in item['context_files']}
    project(folder, state, workspace, context, 'project'); project(folder, state, workspace, context, 'show-project', True)
    selectors = ['--id', item['id'], '--workspace', item['workspace'], '--path', item['path']]
    argv = [str(cli), 'run', str(folder/'project'), '--flow', 'work_save', '--allow-effects', '--trace-out', str(folder/'save.trace.json'),
            '--args', *selectors, '--once', item['request'], '--allow', ','.join(item['allowed'])]
    server = ThreadingHTTPServer(('127.0.0.1', work.PORT), Handler); server.daemon_threads = True
    server.item, server.state, server.records, server.lock = item, state, [], threading.Lock()
    server.partial_at_request, server.preflight_error = None, None
    thread = threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=0.01), daemon=True); thread.start()
    record = dict(name=item['name'], item=item, argv=argv, status='running')
    binding, preview = work.edit.expected(item)
    def preview_check(out, _item, _binding):
        assert preview.encode() in out
        if item.get('storage_failure') == 'INSERT': server.trigger = install_trigger(state, 'INSERT')
        if item.get('readback_mutation'):
            # The body is a JSON string within tagged JSON and contains escaped
            # quotes. Only the outer phase's complete plain JSON string matches.
            sql = "CREATE TRIGGER work_test_readback AFTER INSERT ON memory_entries WHEN NEW.region='" + REGION + "' BEGIN UPDATE memory_entries SET value_json=replace(value_json, '\"summary-unconfirmed\"', '\"summary-confirmed\"') WHERE region=NEW.region AND path=NEW.path AND key_json=NEW.key_json; END"
            with sqlite3.connect(state/'edit.sqlite3') as connection: connection.execute(sql)
            server.trigger = sql
    try:
        out, err, code, milestones = work.edit.run_pty(argv, state, item, workspace, binding, preview_check=preview_check,
            failure_output=lambda out, err: ((folder/'save.stdout.bin').write_bytes(out), (folder/'save.stderr.bin').write_bytes(err)))
        (folder/'save.stdout.bin').write_bytes(out); (folder/'save.stderr.bin').write_bytes(err)
        record.update(exit=code, stdout=out.decode(), stderr=err.decode(), milestones=milestones)
        assert (code == 0) == item['exit_zero']
        assert b'APPLIED '+item['id'].encode() in out and b'EDIT completed ' in out and b'edit_status' in out
        assert (b'SAVED' in out) == item['exit_zero']
        assert all(byte == 10 or 32 <= byte <= 126 for byte in out)
        assert (workspace/item['path']).read_bytes() == item['after'].encode()
        rows = all_rows(state); assert rows['operation']['value'] == dict(format=1, phase='completed', binding=binding)
        assert server.preflight_error is None, server.preflight_error
        work.assert_http(item, server.records, binding)
        record['actions'] = assert_save_trace(json.loads((folder/'save.trace.json').read_text()), item)
        if item.get('storage_failure') == 'INSERT': assert set(rows) == {'operation'} and server.partial_at_request is None
        else:
            current_row = rows['work:'+item['id']]
            if not item.get('readback_mutation'): assert_row(item, binding, server.partial_at_request, 'summary-unconfirmed')
            if item.get('ticket_mutation') == 'value' or item.get('readback_mutation'):
                assert current_row['region'] == REGION and current_row['path'] == ['Rows']
                current = current_row['value']
                assert current == dict(format=1, phase='summary-confirmed', binding=binding, body=current['body'])
                assert json.loads(current['body']) == body_fields(item, binding, 'summary-unconfirmed')
                if item.get('ticket_mutation'):
                    assert current == dict(server.partial_at_request['value'], phase='summary-confirmed')
                    assert current_row['version'] == server.partial_at_request['version']
                else:
                    assert server.partial_at_request is None and b'work record readback mismatch; no retry' in out
                record['show_success'] = False
            else:
                final_phase = 'summary-confirmed' if item['exit_zero'] else 'summary-unconfirmed'
                summary = server.records[-1]['response_text'] if item['exit_zero'] else ''
                assert_row(item, binding, current_row, final_phase, summary)
                if item['exit_zero'] or item.get('ticket_mutation') == 'version':
                    assert current_row['version'] != server.partial_at_request['version']
                record.update(phase=final_phase, summary=summary)
            if item.get('ticket_mutation') == 'value':
                assert b'partial work record binding or version changed; no retry' in out
            elif item.get('ticket_mutation') == 'version':
                assert b'memory host boundary failed: entry revision is outside committed Store history' in err
                assert b'partial work record binding or version changed' not in out
                record.update(show_success=False, storage_observation='native_history_refusal',
                              source_version_comparison='actual not exercised: native Store history validation aborted Memory.read before the application opaque ticket comparison')
        if item.get('storage_failure'):
            record['storage_observation'] = 'native_abort' if b'StorageError' in err else 'returned_refusal' if b'REFUSED ' in out else 'unclassified_abort'
            assert record['storage_observation'] != 'unclassified_abort', record
        record['rows'] = rows
    except BaseException as error: record.update(status='failed', failure=repr(error)); raise
    finally:
        server.shutdown(); thread.join(timeout=2)
        for request in server.records: request['finished'].wait(2)
        server.server_close()
        (folder/'http.json').write_text(json.dumps([{key: value for key, value in request.items() if key != 'finished'} for request in server.records], indent=2)+'\n')
        (folder/'observation.json').write_text(json.dumps(record, indent=2)+'\n')
    # The Model server has ended before each new show process and no provider key
    # or provider adapter is available in the selected read-only profile.
    record['show'] = show(cli, folder, state, item, success=record.get('show_success', True), phase=record.get('phase'), summary=record.get('summary', ''), allow_native_history_trace_missing=item.get('ticket_mutation') == 'version')
    before = work.edit.previous.inspect(state); record['retries'] = []
    for selected in [item['id'], 'changed-id']:
        retry = list(argv); retry[retry.index('--id')+1] = selected
        retry[retry.index('--trace-out')+1] = str(folder/('retry-'+selected+'.trace.json'))
        result = retain_process(folder, 'retry-'+selected, retry, state, provider_free_environment())
        trace_path = Path(retry[retry.index('--trace-out')+1])
        if item.get('ticket_mutation') == 'version':
            assert result.returncode != 0 and not result.stdout
            assert b'failed to open SQLite memory backend' in result.stderr and b': invalid memory Store revision metadata' in result.stderr
            actions = work.actions(json.loads(trace_path.read_text())) if trace_path.exists() else None
            if actions is not None: assert set(actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'}
            retry_observation = dict(id=selected, argv=retry, exit=result.returncode, actions=actions,
                                     entry_execution='actual not exercised: SQLite backend startup rejected invalid Store revision metadata before work_save consumed-slot admission')
            if actions is None: retry_observation['trace_unavailable'] = 'native backend startup produced no CLI trace; actual retry effects not checked'
        else:
            actions = work.actions(json.loads(trace_path.read_text()))
            assert result.returncode != 0 and b'edit operation slot already consumed; no retry' in result.stdout
            assert set(actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'} and actions.count('Memory.read') == 1
            retry_observation = dict(id=selected, argv=retry, exit=result.returncode, actions=actions)
        record['retries'].append(retry_observation)
    assert work.edit.previous.inspect(state) == before and (workspace/item['path']).read_bytes() == item['after'].encode()
    assert context_before == {name: (context/name).read_bytes() for name in item['context_files']}
    record['status'] = 'passed'; (folder/'observation.json').write_text(json.dumps(record, indent=2)+'\n')
    return record


def tagged_field(record, name):
    return next(field['value'] for field in record['fields'] if field['name'] == name)


def corrupt_cases(cli, evidence, source, item):
    result = []
    mutations = ['format', 'phase', 'outer_binding', 'body_binding', 'recomputed_binding', 'literal_proposal', 'canonical_counter', 'decoded_bytes', 'encoded_bytes', 'journal_binding', 'journal_intent', 'journal_missing']
    for name in mutations:
        folder = evidence/('corrupt-'+name); state = folder/'state'; state.mkdir(parents=True)
        with sqlite3.connect((source/'state/edit.sqlite3').as_uri()+'?mode=ro', uri=True) as old:
            with sqlite3.connect(state/'edit.sqlite3') as new: old.backup(new)
        project(folder, state, source/'workspace', source/'context', 'show-project', True)
        with sqlite3.connect(state/'edit.sqlite3') as connection:
            selected_region = 'nomo-edit-operation-v1' if name.startswith('journal_') else REGION
            row = connection.execute('SELECT region,path,key_json,value_json FROM memory_entries WHERE region=?', [selected_region]).fetchone()
            tagged = json.loads(row[3]); body = tagged_field(tagged, 'body') if not name.startswith('journal_') else None
            fields = json.loads(body['value']) if body is not None else []
            if name == 'journal_binding': tagged_field(tagged_field(tagged, 'binding'), 'request_digest')['value'] = 'a'*64
            elif name == 'journal_intent': tagged_field(tagged, 'phase')['value'] = 'intent'
            elif name == 'journal_missing':
                assert connection.execute('DELETE FROM memory_entries WHERE region=?', [selected_region]).rowcount == 1
            elif name == 'format':
                node = tagged_field(tagged, 'format'); node['value'] = '2' if isinstance(node['value'], str) else 2
            elif name == 'phase': tagged_field(tagged, 'phase')['value'] = 'summary-unconfirmed'
            elif name == 'outer_binding': tagged_field(tagged_field(tagged, 'binding'), 'request_digest')['value'] = 'a'*64
            elif name == 'body_binding': fields[2] = 'different-id'
            elif name == 'recomputed_binding':
                fields[6] = 'a'*64; tagged_field(tagged_field(tagged, 'binding'), 'request_digest')['value'] = 'a'*64
            elif name == 'literal_proposal': fields[24] = 'forged result'
            elif name == 'canonical_counter': fields[28] = '07'
            elif name == 'decoded_bytes': fields[25] = '界'*1024
            elif name == 'encoded_bytes': body['value'] = ' '*65537
            if not name.startswith('journal_') and name not in ['format', 'phase', 'outer_binding', 'encoded_bytes']: body['value'] = json.dumps(fields, ensure_ascii=False, separators=(',', ':'))
            if name != 'journal_missing':
                assert connection.execute('UPDATE memory_entries SET value_json=? WHERE region=? AND path=? AND key_json=?',
                                          [json.dumps(tagged, separators=(',', ':')), *row[:3]]).rowcount == 1
        observation = show(cli, folder, state, item, success=False)
        result.append(dict(name=name, status='passed', observation=observation))
        (folder/'observation.json').write_text(json.dumps(result[-1], indent=2)+'\n')
    folder = evidence/'show-selectors'; state = folder/'state'; state.mkdir(parents=True)
    with sqlite3.connect((source/'state/edit.sqlite3').as_uri()+'?mode=ro', uri=True) as old:
        with sqlite3.connect(state/'edit.sqlite3') as new: old.backup(new)
    project(folder, state, source/'workspace', source/'context', 'show-project', True)
    for name, changes, success in [('workspace', dict(workspace='different-workspace'), False),
                                   ('path', dict(path='other.txt'), False), ('invalid_path', dict(path='../outside'), False),
                                   ('id_missing', dict(id='missing-id'), True)]:
        observation = show(cli, folder, state, dict(item, **changes), success=success, label=name)
        result.append(dict(name=name, status='passed', observation=observation))
    for name in ['existing_work', 'existing_corrupt_work']:
        folder = evidence/name; state = folder/'state'; state.mkdir(parents=True)
        with sqlite3.connect((source/'state/edit.sqlite3').as_uri()+'?mode=ro', uri=True) as old:
            with sqlite3.connect(state/'edit.sqlite3') as new: old.backup(new)
        with sqlite3.connect(state/'edit.sqlite3') as connection:
            assert connection.execute('DELETE FROM memory_entries WHERE region=?', ['nomo-edit-operation-v1']).rowcount == 1
            if name == 'existing_corrupt_work':
                row = connection.execute('SELECT value_json FROM memory_entries WHERE region=?', [REGION]).fetchone()
                tagged = json.loads(row[0]); node = tagged_field(tagged, 'format'); node['value'] = '2' if isinstance(node['value'], str) else 2
                connection.execute('UPDATE memory_entries SET value_json=? WHERE region=?', [json.dumps(tagged, separators=(',', ':')), REGION])
        project(folder, state, source/'workspace', source/'context', 'project')
        argv = [str(cli), 'run', str(folder/'project'), '--flow', 'work_save', '--allow-effects', '--trace-out', str(folder/'admission.trace.json'),
                '--args', '--id', item['id'], '--workspace', item['workspace'], '--path', item['path'], '--once', item['request'], '--allow', ','.join(item['allowed'])]
        before = work.edit.previous.inspect(state)
        observed = retain_process(folder, 'admission', argv, state, provider_free_environment())
        actions = work.actions(json.loads((folder/'admission.trace.json').read_text()))
        assert observed.returncode != 0 and b'work record key already exists' in observed.stdout
        assert set(actions) <= {'Policy.evaluate', 'Memory.read', 'Console.stdout_write'} and actions.count('Memory.read') == 2
        assert work.edit.previous.inspect(state) == before
        assert (source/'workspace'/item['path']).read_bytes() == item['after'].encode()
        result.append(dict(name=name, status='passed', argv=argv, exit=observed.returncode, actions=actions))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--suite', choices=['smoke', 'actual', 'corrupt', 'all'], default='smoke'); parser.add_argument('--case', action='append', dest='names')
    parser.add_argument('--prepare-only', action='store_true'); options = parser.parse_args()
    selected = cases()[:1] if options.suite in ['smoke', 'corrupt'] else cases()
    if options.names:
        selected = [item for item in cases() if item['name'] in options.names]; assert set(options.names) == {item['name'] for item in selected}
    options.evidence_dir.mkdir(parents=True, exist_ok=True); evidence = Path(tempfile.mkdtemp(prefix='harness-work-session-', dir=options.evidence_dir))
    (evidence/'cases.json').write_text(json.dumps(selected, indent=2)+'\n'); print('EVIDENCE '+str(evidence), flush=True)
    if options.prepare_only: return
    result = dict(task='HARNESS-WORK-SESSION-001A', status='running', cases=[], corruption=[])
    save = lambda: (evidence/'results.json').write_text(json.dumps(result, indent=2)+'\n'); save()
    try:
        assert os.getuid() == 10001; cli = verify_cli()
        for item in selected:
            result['cases'].append(run_case(cli, evidence, item)); save(); print('PASS '+item['name'], flush=True)
        if options.suite in ['corrupt', 'all']:
            first = next(item for item in selected if item['name'] == 'saved_read')
            result['corruption'] = corrupt_cases(cli, evidence, evidence/'saved_read', first); save()
            print('PASS '+str(len(result['corruption']))+' corrupt/binding cases', flush=True)
        result['status'] = 'passed'
    except BaseException as error: result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'] = {name: (Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.max']}
        r = result['resources']; events = dict(line.split() for line in r['memory.events'].splitlines())
        valid = r['memory.max'] == '4294967296' and r['cpu.max'] == '400000 100000' and r['pids.max'] == '256' and all(events[key] == '0' for key in ['max', 'oom', 'oom_kill', 'oom_group_kill'])
        if not valid: result.update(status='failed', resource_failure='ordinary resource guard failed')
        save(); assert valid


if __name__ == '__main__': main()
