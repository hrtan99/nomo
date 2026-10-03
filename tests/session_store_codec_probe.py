#!/usr/bin/env python3
"""SESSION-STORE-001A codec tests: Python supplies data; Etas executes the codec."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from session_store_probe import EVIDENCE, retain_input

ROOT = Path(__file__).resolve().parent.parent
ETAS = os.environ.get('ETAS', '/validation/target/debug/etas')
GRAPH = Path(os.environ.get('SESSION_STORE_GRAPH', '/validation'))
MARKER = 'nomo-session-bundle-v1'

SOURCE = '''module app.main;
import std.io.{read_all, println};
import std.json.{parse, stringify};
import std.agent.message.Message;
import nomo.bundle_codec.{Bundle, encode, decode};

public flow pure_probe() -> bool {
    let bodies: Array<string> = [];
    let bundle = Bundle { format = 1, session_id = "session", save_id = "save", bodies = bodies };
    return match encode(bundle) {
        Ok(json) => match decode(json) { Ok(result) => result == bundle, Err(_) => false },
        Err(_) => false
    };
}

public flow main(args: Array<string>) -> i32 {
    if !pure_probe() { println("FAIL pure round-trip"); return 1; }
    let empty: Array<string> = [];
    let invalid = Bundle { format = 2, session_id = "session", save_id = "save", bodies = empty };
    match encode(invalid) { Ok(_) => { return 2; }, Err(_) => { println("PASS encode format"); } }
    var many: Array<string> = [];
    var n: usize = 0;
    while n < 33 limit Iterations(33) { many = many.push(""); n = n + 1; }
    let too_many = Bundle { format = 1, session_id = "session", save_id = "save", bodies = many };
    match encode(too_many) { Ok(_) => { return 3; }, Err(_) => { println("PASS encode count"); } }
    let input = match parse(read_all()) { Ok(value) => value, Err(_) => { return 4; } };
    let message = Message.new(input);
    let converted: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let candidates = match converted {
        Some(converted) => converted.body, None => { return 5; }
    };
    for candidate in candidates limit Iterations(100) {
        match decode(candidate) {
            Ok(bundle) => {
                match encode(bundle) {
                    Ok(output) => { println("ACCEPT " + output); },
                    Err(error) => { println("FAIL encode " + error); return 6; }
                }
            },
            Err(error) => { println("REJECT " + error); }
        }
    }
    return 0;
}
'''


def cases():
    result = []

    def accept(name, bodies, session='session', save='save', ascii=False):
        fields = [MARKER, session, save, *bodies]
        result.append((name, json.dumps(fields, ensure_ascii=ascii), fields))

    def reject(name, value):
        result.append((name, value, None))

    accept('zero bodies', [])
    accept('32 empty bodies preserve cardinality', [''] * 32)
    accept('duplicate and empty bodies preserve positions', ['', 'same', 'same', '', 'end'])
    accept('all ASCII controls including NUL', [''.join(chr(n) for n in range(32))])
    accept('literal escapes are not interpreted twice', [r'\n\r\t\u0000\uD83D\uDE80', '\\', '"'])
    accept('Unicode and non-BMP text', ['世界 café e\u0301 🚀 𐀀 \u2028\u2029'])
    accept('escaped Unicode and surrogate pairs', ['世界 café 🚀 𐀀'], ascii=True)
    accept('8192 ASCII characters', ['x' * 8192])
    accept('8192 non-BMP characters', ['🚀' * 8192])
    accept('8192 NUL controls', ['\0' * 8192])
    accept('aggregate across multiple bodies', ['x' * 4096, 'y' * 4096])
    accept('128-character identifiers', [], session='s' * 128, save='v' * 128)
    accept('escaped printable identifiers', [], session='"\\', save='\\"')
    for name, fields in [
        ('33 bodies', [MARKER, 'session', 'save', *([''] * 33)]),
        ('unsupported marker', ['nomo-session-bundle-v2', 'session', 'save']),
        ('missing marker', ['session', 'save']),
        ('empty session identifier', [MARKER, '', 'save']),
        ('empty save identifier', [MARKER, 'session', '']),
        ('long session identifier', [MARKER, 's' * 129, 'save']),
        ('long save identifier', [MARKER, 'session', 'v' * 129]),
        ('Unicode session identifier', [MARKER, '世界', 'save']),
        ('control save identifier', [MARKER, 'session', 'save\n']),
        ('8193 body characters', [MARKER, 'session', 'save', 'x' * 8193]),
        ('aggregate 8193 characters', [MARKER, 'session', 'save', 'x' * 4096, 'y' * 4097]),
        ('numeric body', [MARKER, 'session', 'save', 1]),
        ('null body', [MARKER, 'session', 'save', None]),
        ('nested body', [MARKER, 'session', 'save', []]),
        ('object body', [MARKER, 'session', 'save', {}]),
    ]:
        reject(name, json.dumps(fields, ensure_ascii=False))
    for name, value in [
        ('wrong top-level type', '{}'), ('scalar top level', '"hello"'),
        ('unterminated string', '["unterminated'), ('trailing JSON value', '[] []'),
        ('trailing comma', '["a",]'), ('missing separator', '["a""b"]'),
        ('invalid escape', '["\\q"]'), ('unpaired surrogate', '["\\ud800"]'),
        ('raw control character', '["\0"]'), ('depth limit', '[' * 200 + ']' * 200),
        ('encoded byte limit independent of characters', '["' + '🚀' * 16384 + '"]'),
        ('encoded character limit', ' ' * 65537),
    ]:
        reject(name, value)
    short = json.dumps([MARKER, 'session', 'save'])
    result.append(('exact 65536 encoded byte limit', short + ' ' * (65536 - len(short)), [MARKER, 'session', 'save']))
    reject('65537 encoded bytes', short + ' ' * (65537 - len(short)))
    return result


def main():
    originals = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in [
        'etas.toml', 'etas.lock', 'src/nomo/session_state.es', 'src/nomo/text.es',
        'src/nomo/bundle_codec.es']}
    project = Path(tempfile.mkdtemp(prefix='session-store-codec-', dir=EVIDENCE))
    print('EVIDENCE ' + str(project), flush=True)
    (project / 'src/nomo').mkdir(parents=True)
    (project / 'src/app').mkdir()
    shutil.copyfile(ROOT / 'src/nomo/bundle_codec.es', project / 'src/nomo/bundle_codec.es')
    shutil.copyfile(ROOT / 'src/nomo/text.es', project / 'src/nomo/text.es')
    source = project / 'src/app/main.es'
    source.write_text(SOURCE)
    (project / 'etas.toml').write_text('''[package]
name = "session-store-codec-probe"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "session-store-codec-probe"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.main"
flow = "main"
profile = "fixture"
''')
    results = []
    identity = json.loads((GRAPH / 'binary.json').read_text())
    assert hashlib.sha256(Path(ETAS).read_bytes()).hexdigest() == identity['sha256']
    (project / 'identity.json').write_text(json.dumps(identity, indent=2))
    (project / 'product-sources.json').write_text(json.dumps({str(path.relative_to(project)):
        hashlib.sha256(path.read_bytes()).hexdigest() for path in (project / 'src/nomo').glob('*.es')}, indent=2))

    def invoke(arguments, stdin=None):
        inputs = retain_input(project, source)
        if stdin is not None:
            (project / 'stdin.json').write_text(stdin)
            inputs['stdin.json'] = {'retained': 'stdin.json', 'sha256': hashlib.sha256(stdin.encode()).hexdigest()}
        run = subprocess.run([ETAS, *arguments], input=stdin, capture_output=True, text=True, timeout=240)
        results.append({'command': [ETAS, *arguments], 'exit': run.returncode,
                        'stdout': run.stdout, 'stderr': run.stderr, 'inputs': inputs})
        (project / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        return run

    for command in [['check', '--all', str(project)], ['effects', str(project), '--flow', 'pure_probe']]:
        checked = invoke(command)
        assert checked.returncode == 0, checked.stdout + checked.stderr
        if command[0] == 'effects':
            assert 'requested actions: []' in checked.stdout, checked.stdout
        print(checked.stdout, end='', flush=True)
    all_cases = cases()
    run = invoke(['run', str(project), '--allow-effects'], json.dumps([value for _, value, _ in all_cases], ensure_ascii=False))
    assert run.returncode == 0, (run.returncode, run.stdout, run.stderr)
    assert 'PASS encode format\n' in run.stdout and 'PASS encode count\n' in run.stdout, run.stdout
    outcomes = [line for line in run.stdout.split('\n') if line.startswith(('ACCEPT ', 'REJECT '))]
    assert len(outcomes) == len(all_cases), run.stdout + run.stderr
    for (name, _, expected), line in zip(all_cases, outcomes):
        if expected is None:
            assert line.startswith('REJECT ') and len(line) <= 80, (name, line)
        else:
            assert line.startswith('ACCEPT ') and json.loads(line[7:]) == expected, (name, line[:200])
        print('PASS ' + name, flush=True)
    assert all(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == before for path, before in originals.items())
    print(f'PASS {len(all_cases)} codec runtime cases; 2 direct encode refusals; no Host actions; source hashes preserved', flush=True)


if __name__ == '__main__':
    main()
