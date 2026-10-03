#!/usr/bin/env python3
"""Narrow exact-pin public WriteCondition.Match controls; no storage commit."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
GRAPH = Path(os.environ.get('SESSION_STORE_GRAPH', '/validation'))
CLI = Path(os.environ.get('ETAS', str(GRAPH / 'target/debug/etas')))

MANIFEST = '''[package]
name = "session-store-match-probe"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "session-store-match-probe"
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
'''


def source(imports, expression):
    return '''module app.main;
import std.io.println;
import std.memory.{version, prepare_put, operation_ref};
''' + imports + '''
alias Schema = MemoryRegion<{ Items: Store<string, string> }>;
let Region = std.memory.region<Schema>(stable_id = "match-probe", store = "synthetic");
public flow main(args: Array<string>) -> i32 {
    // Public token construction is only a constructor control. Never commit it.
    let observed = version("synthetic-version-only-not-backend-evidence");
''' + expression + '''
    println("PUBLIC_CONSTRUCTOR_AND_PREPARATION_OK");
    return 0;
}
'''


def main():
    identity = json.loads((GRAPH / 'binary.json').read_text())
    assert hashlib.sha256(CLI.read_bytes()).hexdigest() == identity['sha256']
    protected = ['etas.toml', 'etas.lock', 'src/nomo/session_state.es',
                 'packages/session-store/src/nomo/bundle_codec.es',
                 'packages/session-store/src/nomo/session_store.es']
    before = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in protected}
    evidence = Path(tempfile.mkdtemp(prefix='session-store-match-', dir=GRAPH))
    print('EVIDENCE ' + str(evidence), flush=True)
    prepare = '    let intent = prepare_put(Region.Items, "key", "value", CONDITION);\n    let reference = operation_ref(intent);'
    cases = [
        ('version-control', '', '    if observed.opaque != "synthetic-version-only-not-backend-evidence" { return 1; }'),
        ('missing-control', 'import std.memory.Missing;', prepare.replace('CONDITION', 'Missing')),
        ('imported-match', 'import std.memory.Match;', prepare.replace('CONDITION', 'Match(observed)')),
        ('qualified-match', '', prepare.replace('CONDITION', 'std.memory.Match(observed)')),
        # Intent registration declares WriteCondition as Enum but registers no
        # owned variants. Check qualified spellings; do not assume runtime support.
        ('type-qualified-match', 'import std.memory.WriteCondition;', prepare.replace('CONDITION', 'WriteCondition.Match(observed)')),
        ('fully-type-qualified-match', '', prepare.replace('CONDITION', 'std.memory.WriteCondition.Match(observed)')),
    ]
    results = {'identity': identity, 'scope': 'public constructor and prepare only; no commit or database', 'cases': []}
    for name, imports, expression in cases:
        project = evidence / name
        (project / 'src/app').mkdir(parents=True)
        (project / 'src/app/main.es').write_text(source(imports, expression))
        (project / 'etas.toml').write_text(MANIFEST)
        result = {'name': name, 'commands': []}
        for arguments in [['check', '--all', str(project)], ['run', str(project), '--allow-effects']]:
            command = [str(CLI), *arguments]
            run = subprocess.run(command, capture_output=True, text=True, timeout=45)
            result['commands'].append({'command': command, 'exit': run.returncode,
                                       'stdout': run.stdout, 'stderr': run.stderr})
            if run.returncode != 0:
                break
        results['cases'].append(result)
        (evidence / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        last = result['commands'][-1]
        print(name + ': ' + ('supported' if last['exit'] == 0 else 'failed during ' + last['command'][1]), flush=True)
        if name.endswith('control'):
            assert len(result['commands']) == 2 and last['exit'] == 0 and 'PUBLIC_CONSTRUCTOR_AND_PREPARATION_OK' in last['stdout'], result
    assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in before.items())
    (evidence / 'protected-hashes.json').write_text(json.dumps(before, indent=2))
    print('RECORDED six controls; no storage commit; product/default source hashes preserved', flush=True)


if __name__ == '__main__':
    main()
