#!/usr/bin/env python3
"""Focused line-preview goldens and source-denied edit; no native approval/write."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from edit_contract_probe import literal
from harness_checkpoint_contract_probe import MANIFEST
from model_protocol_probe import resources
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests/fixtures/edit_preview001/preview_probe.es'
DENIAL_LABEL = 'source denial preserves preview and stops before journal'


def ascii_json(value):
    """Independent oracle for the existing canonical PREVIEW encoding."""
    def quote(text):
        output = '"'
        for character in text:
            code = ord(character)
            if character in ('"', '\\'):
                output += '\\' + character
            elif 32 <= code <= 126:
                output += character
            elif code <= 65535:
                output += '\\u' + format(code, '04x')
            else:
                code -= 65536
                output += '\\u' + format(55296 + (code >> 10), '04x')
                output += '\\u' + format(56320 + (code & 1023), '04x')
        return output + '"'
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'))
    return '[' + ','.join(quote(item) for item in value) + ']'


def cases():
    """Explicit goldens; no implementation of prefix/suffix matching here."""
    checks = []
    normal = '--- before\n+++ after\n'
    no_lf = '--- before [no final newline]\n+++ after [no final newline]\n'
    clipped = ' ... [line truncated]'
    def add(label, before, after, expected='', error=''):
        checks.append(dict(label=label, before=before, after=after, expected=expected, error=error))
    add('single line', 'old', 'new', no_lf + '- old\n+ new\n')
    add('multiline change', 'head\nold\nleft\nend\n', 'head\nnew\nright\nend\n',
        normal + '  head\n- old\n- left\n+ new\n+ right\n  end\n')
    add('first line', 'old\ntail\n', 'new\ntail\n', normal + '- old\n+ new\n  tail\n')
    add('last line', 'head\nold\n', 'head\nnew\n', normal + '  head\n- old\n+ new\n')
    add('repeated lines stay positioned', 'same\nold\nsame\nsame\n', 'same\nnew\nsame\nsame\n',
        normal + '  same\n- old\n+ new\n  same\n  same\n')
    add('Unicode scalar escapes', '前😀', '新😀', no_lf + '- \\u524d\\ud83d\\ude00\n+ \\u65b0\\ud83d\\ude00\n')
    add('Unicode is not normalized', 'é', 'é', no_lf + '- \\u00e9\n+ e\\u0301\n')
    add('CRLF stays visible', 'head\r\nold\r\n', 'head\r\nnew\r\n',
        normal + '  head\\u000d\n- old\\u000d\n+ new\\u000d\n')
    add('mixed endings', 'old\r\nend', 'new\nend', no_lf + '- old\\u000d\n+ new\n  end\n')
    add('adding final LF is a change', 'same', 'same\n',
        '--- before [no final newline]\n+++ after\n- same\n+ same\n')
    add('removing final LF is a change', 'same\n', 'same',
        '--- before\n+++ after [no final newline]\n- same\n+ same\n')
    add('delete entire file', 'old\n', '', '--- before\n+++ after [empty file]\n- old\n')
    add('empty before has no phantom line', '', 'new\n', '--- before [empty file]\n+++ after\n+ new\n')
    add('blank lines are data', '\nold\n\n', '\nnew\n\n', normal + '  \n- old\n+ new\n  \n')
    add('omitted edge context is counted', 'a\nb\nc\nd\nold\nw\nx\ny\nz\n',
        'a\nb\nc\nd\nnew\nw\nx\ny\nz\n',
        normal + '... 2 unchanged lines omitted ...\n  c\n  d\n- old\n+ new\n  w\n  x\n... 2 unchanged lines omitted ...\n')
    add('changed blocks are bounded', 'o\n' * 14, 'n\n' * 13,
        normal + '- o\n' * 12 + '... 2 removed lines omitted ...\n' + '+ n\n' * 12 + '... 1 added lines omitted ...\n')
    add('exact encoded column bound', 'o' * 160, 'n' * 160, no_lf + '- ' + 'o' * 160 + '\n+ ' + 'n' * 160 + '\n')
    add('long lines visibly clipped', 'o' * 161, 'n' * 161,
        no_lf + '- ' + 'o' * 160 + clipped + '\n+ ' + 'n' * 160 + clipped + '\n')
    controls = '\t\r\x1b\x7f\x85\x9b\u202e"\\'
    add('terminal and bidi controls escaped', controls, 'safe', no_lf + '- ' + ascii_json([controls])[2:-2] + '\n+ safe\n')
    add('escape unit clipping', '\x1b' * 27, 'safe', no_lf + '- ' + '\\u001b' * 26 + clipped + '\n+ safe\n')
    add('surrogate pair clipping', '😀' * 14, 'safe', no_lf + '- ' + '\\ud83d\\ude00' * 13 + clipped + '\n+ safe\n')
    add('full 2048 byte lines bounded', '\x1b' * 2048, '\x02' * 2048,
        no_lf + '- ' + '\\u001b' * 26 + clipped + '\n+ ' + '\\u0002' * 26 + clipped + '\n')
    add('full 2048 line input bounded', '\n' * 2048, 'n\n' * 1024,
        normal + '- \n' * 12 + '... 2036 removed lines omitted ...\n' + '+ n\n' * 12 + '... 1012 added lines omitted ...\n')
    add('UTF8 byte bound accepted', 'é' * 1024, 'safe', no_lf + '- ' + '\\u00e9' * 26 + clipped + '\n+ safe\n')
    add('legacy before byte bound lifted', 'x' * 2049, 'safe',
        no_lf + '- ' + 'x' * 160 + clipped + '\n+ safe\n')
    add('legacy after byte bound lifted', 'old', 'x' * 2049,
        no_lf + '- old\n+ ' + 'x' * 160 + clipped + '\n')
    add('legacy UTF8 byte bound lifted', 'é' * 1024 + 'x', 'safe',
        no_lf + '- ' + '\\u00e9' * 26 + clipped + '\n+ safe\n')
    add('NUL refused', 'o\x00ld', 'new', error='preview before contains NUL')
    add('unchanged refused', 'same\n', 'same\n', error='edit preview requires a change')
    assert len(checks) == 29 and len({item['label'] for item in checks}) == 29
    return checks


def sources():
    pending, found = ['nomo.ui.edit_diff', 'nomo.entry.edit_coordinator'], {}
    while pending:
        module = pending.pop()
        if module in found:
            continue
        path = (ROOT / 'src').joinpath(*module.split('.')).with_suffix('.es')
        body = path.read_text()
        assert re.findall(r'^\s*module\s+([\w.]+)\s*;', body, re.M) == [module], path
        found[module] = path
        for imported in re.findall(r'^\s*(?:public\s+)?import\s+(nomo(?:\.[A-Za-z_]\w*)*)[.\s;]', body, re.M):
            parts = imported.split('.')
            matches = ['.'.join(parts[:end]) for end in range(2, len(parts) + 1)
                       if (ROOT / 'src').joinpath(*parts[:end]).with_suffix('.es').is_file()]
            assert len(matches) == 1, imported
            pending.append(matches[0])
    return found


def denied_output():
    before, after = 'head\n前😀 old\nend\n', 'head\n前😀 新😀\nend\n'
    selected = dict(id='preview-denied', workspace='preview-fixture', region='nomo.tools.edit_file.EditableRoot', path='docs/说明.txt')
    canonical = ascii_json(['nomo-edit-request-v1', *selected.values(), before, 'old', '新😀', after])
    digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
    request_digest = digest(canonical)
    preview = dict(format='nomo-edit-preview-v1', **selected, before=before, target='old', replacement='新😀', after=after,
                   before_bytes=str(len(before.encode())), after_bytes=str(len(after.encode())),
                   before_digest=digest(before), after_digest=digest(after), request_digest=request_digest)
    return ('PREVIEW ' + ascii_json(preview) + '\nDIFF request=' + request_digest + '\n'
            '--- before\n+++ after\n  head\n- \\u524d\\ud83d\\ude00 old\n+ \\u524d\\ud83d\\ude00 \\u65b0\\ud83d\\ude00\n  end\n\n'
            'WARNING File permissions, including executable bits, may change during this edit.\n'
            'CONFIRM Native gate requires yes; then confirm this request with y/yes.\n'
            'SOURCE_APPROVAL_DENIED Nomo edit preview-denied request=' + request_digest + '\nPASS ' + DENIAL_LABEL + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    options = parser.parse_args()
    options.evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='edit-preview001-', dir=options.evidence_dir)).resolve()
    project = evidence / 'project'; (project / 'src/app').mkdir(parents=True)
    copied = {}
    for source in sources().values():
        relative = source.relative_to(ROOT); target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target)
        copied[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
    checks = cases()
    record = lambda item: 'Check { ' + ', '.join(key + ' = ' + literal(value) for key, value in item.items()) + ' }'
    generated = FIXTURE.read_text().replace('__CHECKS__', '[' + ',\n'.join(map(record, checks)) + ']')
    (project / 'src/app/preview_probe.es').write_text(generated)
    manifest = MANIFEST.replace('harness-checkpoint-contract-probe', 'edit-preview001').replace('app.contract_probe', 'app.preview_probe')
    manifest = manifest.replace('rules = ["console=allow"]',
        'rules = ["console=allow", "memory=allow", "approval=allow", "filesystem=allow"]')
    manifest = manifest.replace('mode = "deny"', 'mode = "prompt"')
    manifest += '''
[runtime.profiles.fixture.memory]
backend = "sqlite"
path = "/tmp/edit-preview001.sqlite3"
[runtime.profiles.fixture.filesystem.regions."nomo.tools.edit_file.EditableRoot"]
root = "/tmp"
read = true
write = true
delete = false
'''
    (project / 'etas.toml').write_text(manifest)
    result = dict(task='EDIT-PREVIEW-001', status='prepared', sources=copied,
                  fixture_sha256=hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), checks=[item['label'] for item in checks], commands=[],
                  qualification='Pure line display and source-handled Approval=false in the existing execute controller. Actual host Approval0; no native consent/write/lifecycle claim.')
    output = evidence / 'results.json'
    def save():
        output.write_text(json.dumps(result, indent=2) + '\n')
    save(); print('EVIDENCE ' + str(evidence), flush=True)
    if options.prepare_only:
        return 0
    try:
        cli = verify_cli(); result['compiler'] = str(cli); result['status'] = 'running'; save()
        commands = [('check', [cli, 'check', '--all', project]),
                    ('pure-effects', [cli, 'effects', project, '--flow', 'pure_probe']),
                    ('denied-effects', [cli, 'effects', project, '--flow', 'denied']),
                    ('observe', [cli, 'run', project, '--flow', 'observe', '--allow-effects', '--trace-out', evidence / 'observe.trace.json']),
                    ('denied', [cli, 'run', project, '--flow', 'denied', '--allow-effects', '--trace-out', evidence / 'denied.trace.json'])]
        for label, argv in commands:
            item = dict(label=label, command=list(map(str, argv))); result['commands'].append(item); save()
            try:
                observed = subprocess.run(item['command'], capture_output=True, stdin=subprocess.DEVNULL, timeout=180)
                out, err = observed.stdout, observed.stderr
            except subprocess.TimeoutExpired as error:
                out, err = error.output or b'', error.stderr or b''
                (evidence / (label + '.stdout.bin')).write_bytes(out); (evidence / (label + '.stderr.bin')).write_bytes(err)
                item.update(timeout=True, stdout=out.decode(errors='replace'), stderr=err.decode(errors='replace')); save(); raise
            (evidence / (label + '.stdout.bin')).write_bytes(out); (evidence / (label + '.stderr.bin')).write_bytes(err)
            item.update(exit=observed.returncode, stdout=out.decode(), stderr=err.decode()); save()
            assert observed.returncode == 0 and not err, (label, item, str(evidence))
            if label.endswith('-effects'):
                support = re.findall(r'^\s*support:\s*(.+?)\s*$', item['stdout'], re.M)
                assert len(support) == 1, ('missing or ambiguous interpreter support', item)
                assert re.fullmatch(r'(?:local|requires-host\[[^\n]*\]|requires-orchestration\[[^\n]*\])', support[0]), ('interpreter support rejected or unknown', item)
                item['interpreter_support'] = support[0]; save()
            if label == 'pure-effects':
                assert item['stdout'].count('requested actions: []') == item['stdout'].count('default actions: []') == 1, item
            elif label == 'denied-effects':
                assert 'Agentic.' not in item['stdout'], item
            elif label == 'observe':
                assert item['stdout'] == ''.join('PASS ' + value['label'] + '\n' for value in checks), item
            elif label == 'denied':
                assert item['stdout'] == denied_output(), item
        traces = {}
        for name in ('observe', 'denied'):
            raw = json.loads((evidence / (name + '.trace.json')).read_text())
            starts = [event for event in raw['events'] if event['kind'] == 'host_request_started']
            finishes = [event for event in raw['events'] if event['kind'] == 'host_request_finished']
            actions = [event['qualified_action'] for event in starts]
            assert set(actions) <= {'Policy.evaluate', 'Console.stdout_write'}, actions
            assert len(starts) == len(finishes) and {event['id'] for event in starts} == {event['id'] for event in finishes}
            assert raw['termination']['local_work_settled'] is True and raw['outcome']['kind'] == 'completed'
            traces[name] = dict(actions=actions, actual=dict(Model=0, HTTP=0, Memory=0, File=0, Approval=0, atomic=0))
        result.update(status='passed', traces=traces, source_approval_denials=1)
    except BaseException as error:
        result.update(status='failed', failure=repr(error)); raise
    finally:
        result['resources'], valid = resources()
        if not valid:
            result.update(status='failed', resource_failure='ordinary4GiB resource guard failed')
        save(); assert valid, result
    print('PASS 29 edit preview goldens and source-denied execution; zero Model/journal/File', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
