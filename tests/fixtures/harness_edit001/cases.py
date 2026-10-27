"""Owned one-shot edit requests and independent expected file/outcome values."""
import hashlib
import json

TOKEN = 'NOMO_HARNESS_EDIT_LOOPBACK_NOT_A_SECRET'
PORT = 18867
MODEL = 'qwen3.8-flash-next-ud-iq4_xs'
PHASE_TOKENS = dict(plan=4096, child=32768, aggregate=2048)
PHASE_CONTEXT_TOKENS = dict(plan=32768, child=98304, aggregate=163840)
CONTEXT_BYTES = 65536
BEFORE = '前😀\r\nold\x1b\x7f\x9b\n'


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def case(name, **changes):
    item = dict(name=name, kind='success', id='owned-edit', workspace='owned-label', path='note.txt',
                request='blue', before=BEFORE, target='old', calls=3, atomic=1, phase='completed',
                changed=True, preview=True, exit_zero=True, aggregate=True, source='task')
    item.update(changes)
    item.setdefault('task', 'replace with '+item['request'])
    item.setdefault('replacement', item['request'])
    item['after'] = item['before'].replace(item['target'], item['replacement'], 1)
    return item


def final_answer(context):
    return 'Confirmed '+context['request']+' => '+context['after_digest']


def cases():
    early = dict(calls=2, atomic=0, phase='empty', changed=False, preview=False, exit_zero=False, aggregate=False)
    confirmed = dict(calls=2, atomic=0, phase='empty', changed=False, exit_zero=False, aggregate=False)
    values = [
        case('applied'),
        case('task_changes_edit', task='replace with green', replacement='green', plan_raw=encoded(['delegate', 'replace with green'])),
        case('unicode_task_and_summary', request='蓝😀\n色'),
        case('original_changes_aggregation', before='different old suffix\r\n'),
        case('child_changes_edit', source='literal', replacement='violet'),
        case('full_2048_control_context', source='literal', request='boundary', before='\x1b'*2048,
             target='\x1b'*2048, replacement='\x02'*2048, usage_prompt_tokens=10000),
        case('invalid_plan', plan_raw='["edit","old","x"]', **dict(early, calls=1)),
        case('nested_child', child_raw='["edit",["old"],"x"]', **early),
        case('extra_child_binding', child_raw='["edit","old","x","other.txt"]', **early),
        case('ambiguous_target', before='old old', **early),
        case('unchanged_request', source='literal', replacement='old', **early),
        case('replacement_2049', source='literal', replacement='x'*2049, **early),
        case('child_output_32769', child_raw='x'*32769, **early),
        case('child_token_allowance', fail_phase='child', fail_mode='token_overrun', **early),
        case('non_tty', kind='non_tty', **confirmed),
        case('native_no', kind='native_no', **confirmed),
        case('nomo_no', kind='nomo_no', **confirmed),
        case('original_mismatch', kind='mismatch', **dict(confirmed, phase='intent')),
        case('completion_refusal', kind='completion_error', **dict(confirmed, atomic=1, phase='intent', changed=True)),
        case('aggregate_invalid', final_text='x'*513, exit_zero=False),
        case('aggregate_host_failure', fail_phase='aggregate', fail_mode='unavailable', exit_zero=False),
        case('read_only_file_error', kind='read_only', **dict(confirmed, atomic=1, phase='intent')),
    ]
    assert len(values) == 22 and len({item['name'] for item in values}) == 22
    assert all(len(item['before'].encode()) <= 2048 for item in values)
    return values


def selected(suite):
    values = cases()
    if suite == 'smoke': return values[:1]
    if suite == 'matrix': return values[1:-1]
    if suite == 'readonly': return values[-1:]
    return values


def aggregate_fields(item, binding):
    return dict(phase='aggregate', request=item['request'], task=item['task'], id=item['id'],
                workspace=item['workspace'], path=item['path'], before=item['before'], after=item['after'],
                request_digest=binding['request_digest'], before_digest=binding['before_digest'],
                after_digest=binding['after_digest'], before_bytes=binding['before_bytes'],
                after_bytes=binding['after_bytes'], completed=True)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()
