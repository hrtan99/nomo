"""Independent owned read-context/edit inputs and exact typed-context goldens."""
import json

ORDER = ['read-plan', 'read-child-first', 'read-child-final', 'read-aggregate', 'edit-plan', 'edit-child', 'edit-aggregate']
OUTPUT = [2048, 2048, 2048, 2048, 4096, 32768, 2048]
NATIVE = [8192, 16384, 24576, 32768, 65536, 131072, 196608]
READ_REGION = 'nomo.tools.workspace.ReadOnlyRoot'
READ_TASK = 'Read the selected context file'
READ_LEDGER = dict(steps=7, calls=4, tokens=8192, tools=1, scan=4096)


def encoded(value): return json.dumps(value, ensure_ascii=True, separators=(',', ':'))
def event(role, kind, name, text): return dict(role=role, kind=kind, name=name, text=text)


def display(text):
    return text.replace('<', '<LT>').replace('\n', '<LF>').replace('\r', '<CR>').replace('\t', '<TAB>')


def outcome(item):
    if item['operation'] == 'read': return 'complete: '+display(item['context_files'][item['allowed'][0]])
    text = ''.join(name+':'+str(number)+'\n' for name in item['allowed']
                   for number, line in enumerate(item['context_files'][name].split('\n'), 1) if item['literal'] in line)
    return 'complete: '+display(text)


def selected_value(operation, observed):
    body = observed.removeprefix('complete: ')
    if operation == 'read':
        assert body in ['blue', 'green']; return body
    return {'1': 'one', '2': 'two'}[body.split('<LF>')[0].rsplit(':', 1)[1]]


def action(item):
    return ['read', item['allowed'][0]] if item['operation'] == 'read' else ['search', item['literal'], *item['allowed']]


def case(name, **changes):
    item = dict(name=name, kind='success', id='owned-edit', workspace='owned-label', path='note.txt',
                request='Update the old value using the selected context', read_task=READ_TASK,
                allowed=['context.txt'], context_files={'context.txt': 'blue'}, operation='read', literal='',
                before='old\n', target='old', calls=7, read_reads=1, edit_reads=3, atomic=1,
                phase='completed', changed=True, preview=True, exit_zero=True, aggregate=True)
    item.update(changes)
    value = selected_value(item['operation'], outcome(item)) if not item.get('unsupported') else 'blue'
    item['task'] = 'replace selected with '+value
    item['replacement'] = ('\x02' if value == 'blue' else '\x03')*2048 if item.get('boundary') else value
    item['after'] = item['before'].replace(item['target'], item['replacement'], 1)
    return item


def cases():
    early = dict(atomic=0, phase='empty', changed=False, preview=False, exit_zero=False, aggregate=False, edit_reads=0)
    denial = dict(calls=6, atomic=0, phase='empty', changed=False, exit_zero=False, aggregate=False, edit_reads=1)
    values = [
        case('context_blue'),
        case('context_green', context_files={'context.txt': 'green'}),
        case('search_two_files', operation='search', literal='CHOSEN', allowed=['context.txt', 'other.txt'],
             context_files={'context.txt': 'skip\nCHOSEN\n', 'other.txt': 'CHOSEN\n'}, read_reads=2),
        case('full_edit_context_2048', boundary=True, before='\x1b'*2048, target='\x1b'*2048, edit_usage_prompt=10000),
        case('read_plan_malformed', read_plan_raw='["edit","x"]', calls=1, read_reads=0, **early),
        case('read_child_malformed', read_action_raw='["read",["context.txt"]]', calls=2, read_reads=0, **early),
        case('read_direct_final_refused', read_action_raw='["final","No actual tool"]', calls=2, read_reads=0, **early),
        case('read_second_tool_refused', read_final_raw='["read","context.txt"]', calls=3, **early),
        case('read_outcome_unsupported', context_files={'context.txt': '蓝'}, unsupported=True, calls=2, **early),
        case('read_cumulative_budget', fail_phase='read-child-final', fail_mode='token_overrun', calls=3, **early),
        case('edit_child_malformed', edit_child_raw='["edit",["old"],"x"]', **dict(denial, preview=False)),
        case('edit_cumulative_budget', fail_phase='edit-child', fail_mode='token_overrun', **dict(denial, preview=False)),
        case('non_tty', kind='non_tty', **denial),
        case('native_no', kind='native_no', **denial),
        case('nomo_no', kind='nomo_no', **denial),
        case('original_mismatch', kind='mismatch', **dict(denial, phase='intent', edit_reads=2)),
        case('completion_refusal', kind='completion_error', **dict(denial, atomic=1, phase='intent', changed=True, edit_reads=3)),
        case('completed_summary_failure', fail_phase='edit-aggregate', fail_mode='unavailable', exit_zero=False),
    ]
    assert len(values) == 18 and len({value['name'] for value in values}) == 18
    return values


def selected(suite):
    values = cases()
    return values[:1] if suite == 'smoke' else values[1:] if suite == 'matrix' else values[:2] if suite == 'pair' else values


def evidence(item):
    observed = outcome(item)
    return dict(request=item['request'], task=item['read_task'], operation=item['operation'], files=item['allowed'],
                literal=item['literal'], outcome=observed, result='Seen: '+observed, summary='Summary: '+observed,
                allowed=item['allowed'], ledger=READ_LEDGER)


def context(item, ordinal, binding):
    if ordinal in [0, 3]:
        aggregate = ordinal == 3; observed = outcome(item)
        return dict(phase='aggregate' if aggregate else 'plan', request=item['request'],
                    task=item['read_task'] if aggregate else '', result='Seen: '+observed if aggregate else '',
                    tool=item['operation'] if aggregate else '', outcome=observed if aggregate else '', allowed=item['allowed'])
    if ordinal in [1, 2]:
        history = [event('user', 'context', 'original', item['request']), event('user', 'input', '', item['read_task'])]
        if ordinal == 2:
            raw = item.get('read_action_raw', encoded(action(item)))
            history += [event('model', 'text', 'qwen', ''), event('model', 'request', item['operation'], raw),
                        event('tool', 'complete', item['operation'], outcome(item))]
        return dict(history=history, allowed=item['allowed'], final_only=ordinal == 2)
    phase = ['plan', 'child', 'aggregate'][ordinal-4]
    edit = dict(phase=phase, request=item['request'], task='' if ordinal == 4 else item['task'], id=item['id'],
                workspace=item['workspace'], path=item['path'], before=item['before'], after='', request_digest='',
                before_digest='', after_digest='', before_bytes=len(item['before'].encode()), after_bytes=0, completed=False)
    if ordinal == 6:
        edit.update(after=item['after'], request_digest=binding['request_digest'], before_digest=binding['before_digest'],
                    after_digest=binding['after_digest'], after_bytes=binding['after_bytes'], completed=True)
    return dict(edit=edit, evidence=evidence(item))


def final_answer(context):
    value = selected_value(context['evidence']['operation'], context['evidence']['outcome'])
    return 'Confirmed '+value+' => '+context['edit']['after_digest']
