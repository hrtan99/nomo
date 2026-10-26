#!/usr/bin/env python3
"""Focused pure edit argument, binding and canonical-encoding checks."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from harness_checkpoint_contract_probe import MANIFEST
from session_lifecycle_contract_probe import literal as established_literal
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/tool002b/contract_probe.es'
MODULES = ['core/text.es', 'tools/path_policy.es', 'tools/edit_proposal.es',
           'tools/edit_encoding.es', 'session/edit_operation.es', 'cli/edit_args.es']


def literal(value):
    if isinstance(value, list): return '['+', '.join(literal(item) for item in value)+']'
    text = established_literal(value)
    if isinstance(value, str):
        # The source lexer does not decode JSON's six-character Unicode escapes.
        for code in range(32): text = text.replace('\\u'+format(code, '04x'), chr(code))
    return text


def record(name, value):
    return name+' { '+', '.join(key+' = '+literal(data) for key, data in value.items())+' }'


def cases():
    checks = []
    def add(label, expression): checks.append((label, expression))
    options = dict(help=False, id='op', workspace='owned', path='note.txt', target='x', replacement='')
    argv = ['--id', 'op', '--workspace', 'owned', '--path', 'note.txt', '--target', 'x', '--replacement', '']
    def arguments(args, applying=True, expected=None, error=''):
        return 'arguments('+literal(args)+', '+literal(applying)+', '+record('Options', expected or options)+', '+literal(error)+')'
    add('apply_empty_replacement', arguments(argv))
    changed = dict(options, target='前😀', replacement='新')
    add('reordered_unicode_arguments', arguments(['--replacement', '新', '--target', '前😀', '--path', 'note.txt', '--workspace', 'owned', '--id', 'op'], expected=changed))
    add('status_has_no_supplied_edit', arguments(argv[:6], False, dict(options, target='')))
    add('help_is_selector_free', arguments(['--help'], expected=dict(help=True, id='', workspace='', path='', target='', replacement='')))
    add('missing_pair_refused', arguments(argv[:-1], error='expected --id ID --workspace BIND --path FILE and apply --target TEXT --replacement TEXT'))
    add('duplicate_option_refused', arguments(argv[:6]+['--target', 'x', '--target', 'y'], error='duplicate edit option'))
    add('unknown_and_status_edit_refused', arguments(argv[:8]+['--other', 'z'], error='unknown edit option')+' && '+arguments(['--id', 'op', '--workspace', 'owned', '--target', 'x'], False, error='unknown edit option'))
    add('empty_target_refused', arguments(argv[:7]+['']+argv[8:], error='target must not be empty'))
    add('unsafe_selectors_refused', arguments(['--id', '\x1b', *argv[2:]], error='invalid edit operation identity')+' && '+arguments(argv[:5]+['../outside']+argv[6:], error='invalid relative path'))
    values = ['"\\/', '\x01\n\r\t\x7f\x85\x9b', '前😀', '', 'é é']
    golden = r'["\"\\/","\u0001\u000a\u000d\u0009\u007f\u0085\u009b","\u524d\ud83d\ude00","","\u00e9 e\u0301"]'
    assert json.loads(golden) == values and golden.isascii()
    add('canonical_json_controls_unicode_roundtrip', 'encoded('+literal(values)+', '+literal(golden)+', "")')
    add('json_empty_and_field_bound', 'encoded([], "[]", "") && encoded('+literal(['']*17)+', "", "edit JSON field count exceeds bound")')
    named_golden = r'{"\"\\/":"\u0001\u524d\ud83d\ude00","empty":""}'
    assert json.loads(named_golden) == {'"\\/': '\x01前😀', 'empty': ''}
    add('named_json_escapes_keys_and_values', 'named('+literal(['"\\/', 'empty'])+', '+literal(['\x01前😀', ''])+', '+literal(named_golden)+', "")')
    add('named_json_duplicate_and_arity_refused', 'named(["x", "x"], ["a", "b"], "", "duplicate edit JSON key") && named(["x"], [], "", "edit JSON key/value count invalid")')
    sha = [('', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
           ('abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
           ('前😀', hashlib.sha256('前😀'.encode()).hexdigest())]
    add('sha256_known_vectors', ' && '.join('hashed('+literal(text)+', '+literal(digest)+')' for text, digest in sha))
    binding = dict(id='op', workspace='owned', region='nomo.tools.edit_file.EditableRoot', path='note.txt',
                   request_digest='a'*64, before_digest='b'*64, after_digest='c'*64, before_bytes=2048, after_bytes=0)
    b = lambda **changes: record('Binding', dict(binding, **changes))
    row = lambda **changes: 'Record { format = '+str(changes.get('format', 1))+', phase = '+literal(changes.get('phase', 'intent'))+', binding = '+b()+' }'
    add('valid_intent_and_completed_records', 'binding_error('+b()+') == "" && record_error('+row()+') == "" && record_error('+row(phase='completed')+') == "" && same_record('+row()+', '+row()+')')
    invalid = [({'region':'wrong'}, 'edit region binding mismatch'), ({'request_digest':'A'*64}, 'invalid edit SHA-256 digest'),
               ({'before_bytes':0}, 'invalid edit byte lengths'), ({'after_bytes':2049}, 'invalid edit byte lengths'),
               ({'after_digest':'b'*64}, 'edit digests do not describe a change')]
    add('malformed_binding_refused', ' && '.join('binding_error('+b(**changes)+') == '+literal(error) for changes, error in invalid))
    add('binding_identity_and_path_refused', ' && '.join('binding_error('+b(**change)+') != ""' for change in [{'id':''}, {'workspace':'   '}, {'path':'../outside'}]))
    changes = [{'id':'different'}, {'workspace':'different'}, {'region':'different'}, {'path':'other.txt'},
               {'request_digest':'d'*64}, {'before_digest':'d'*64}, {'after_digest':'d'*64}, {'before_bytes':2047}, {'after_bytes':1}]
    add('every_binding_field_compared', 'different_bindings('+b()+', ['+', '.join(b(**change) for change in changes)+'])')
    add('record_format_and_phase_compared', 'record_error('+row(format=2)+') != "" && record_error('+row(phase='unknown')+') != "" && !same_record('+row()+', '+row(phase='completed')+') && !same_record('+row()+', '+row(format=2)+')')
    assert len(checks) == 19
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args(); checks = cases()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='edit-contract-', dir=args.evidence_dir)); project = evidence/'project'
    (project/'src/app').mkdir(parents=True)
    for name in MODULES:
        target = project/'src/nomo'/name; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT/'src/nomo'/name, target)
    expressions = ['Check { label = '+literal(label)+', passed = '+expression+' }' for label, expression in checks]
    (project/'src/app/contract_probe.es').write_text(FIXTURE.read_text().replace('__CHECKS__', '['+',\n'.join(expressions)+']'))
    (project/'etas.toml').write_text(MANIFEST.replace('harness-checkpoint-contract-probe', 'edit-contract-probe'))
    result = dict(task='TOOL-002B-pure', status='prepared', checks=[label for label, _ in checks], commands=[])
    output = evidence/'results.json'
    save = lambda: output.write_text(json.dumps(result, indent=2)+'\n')
    save(); print('EVIDENCE '+str(evidence), flush=True)
    if args.prepare_only: return
    try:
        cli = verify_cli()
        commands = [('check', [cli, 'check', '--all', project], 'checked 7 files\n'),
                    ('effects', [cli, 'effects', project, '--flow', 'pure_probe'], None),
                    ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects'], ''.join('PASS '+label+'\n' for label, _ in checks))]
        for label, argv, expected in commands:
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save()
            observed = subprocess.run(item['command'], capture_output=True, timeout=120)
            (evidence/(label+'.stdout.bin')).write_bytes(observed.stdout); (evidence/(label+'.stderr.bin')).write_bytes(observed.stderr)
            item.update(exit=observed.returncode, stdout=observed.stdout.decode(), stderr=observed.stderr.decode()); save()
            assert observed.returncode == 0 and not observed.stderr, item
            if expected is not None: assert item['stdout'] == expected, item
            else: assert item['stdout'].count('requested actions: []') == item['stdout'].count('default actions: []') == 1, item
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'] = {name: (Path('/sys/fs/cgroup')/name).read_text().strip() for name in
                               ['memory.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.max']}
        resource = result['resources']; events = dict(line.split() for line in resource['memory.events'].splitlines())
        valid = resource['memory.max'] == '4294967296' and resource['cpu.max'] == '400000 100000' and resource['pids.max'] == '256' and all(events[key] == '0' for key in ['max', 'oom', 'oom_kill', 'oom_group_kill'])
        if not valid: result.update(status='failed', resource_failure='ordinary resource guard failed')
        save(); assert valid, result
    print('PASS 19 grouped pure edit checks', flush=True)


if __name__ == '__main__': main()
