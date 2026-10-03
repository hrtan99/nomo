#!/usr/bin/env python3
"""Assert the merged Match fix and a prepared-publication replacement in owned copies."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from session_store_match_probe import MANIFEST, source
from session_store_probe import expected, fixture_source, plain
from session_store_fault_probe import contents, stored
from session_state_probe import snapshot

ROOT = Path(__file__).resolve().parent.parent
BASE = Path('/validation')
CLI = BASE / 'target/debug/etas'
HOST = BASE / 'target/debug/nomo-session-store-host-faults'
PRODUCT = ['bundle_codec.es', 'store_record.es', 'metadata_store.es', 'history_store.es', 'session_store.es']
SHARED = ['conversation.es', 'session_state.es', 'text.es']
MARKER = 'AFTER_STORE_CALL\n'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    cli_identity = json.loads((BASE / 'binary.json').read_text())
    host_identity = json.loads((BASE / 'host-faults-identity.json').read_text())
    assert digest(CLI) == cli_identity['sha256']
    assert digest(HOST) == host_identity['fixture_binary_sha256']
    assert digest(BASE / 'host-faults/Cargo.lock') == host_identity['fixture_lock_sha256']
    for name, fingerprint in host_identity['fixture_source_sha256'].items():
        assert digest(BASE / 'host-faults' / name) == fingerprint
    paths = [ROOT / 'packages/session-store/src/nomo' / name for name in PRODUCT]
    paths += [ROOT / 'src/nomo' / name for name in SHARED]
    paths += [ROOT / name for name in ['etas.toml', 'etas.lock', 'scripts/etas-013-isolated.py',
              'tests/session_store_match_probe.py', 'examples/repros/ETAS-0013/verify.py',
              'examples/repros/ETAS-0013/etas.toml', 'examples/repros/ETAS-0013/src/app/main.es']]
    protected = {str(path): digest(path) for path in paths}
    evidence = Path(tempfile.mkdtemp(prefix='etas0013-fixed-cases-', dir=BASE))
    print('EVIDENCE ' + str(evidence), flush=True)
    results = {'meaning': 'all success assertions verify fixed behavior, not the historical failing observer',
               'cli_identity': cli_identity, 'host_identity': host_identity,
               'protected_sources': protected, 'commands': [], 'completed': []}
    retained = evidence / 'drivers'
    retained.mkdir()
    for name in ['etas0013_fixed_probe.py', 'session_store_probe.py', 'session_store_match_probe.py',
                 'session_store_fault_probe.py', 'session_state_probe.py', 'tool_workspace_probe.py']:
        shutil.copyfile(ROOT / 'tests' / name, retained / name)
    results['retained_drivers'] = {path.name: digest(path) for path in retained.iterdir()}
    results['effective_host_profile'] = {
        'profile_kind': 'embedded test Host configuration; fixture manifest not consumed by embedder',
        'run_options': 'RunOptions::default()', 'entry_module': 'app.main', 'entry_flow': 'main',
        'console': 'captured writes only', 'other_services': 'denied',
        'database_and_fault': 'explicit per-command synthetic directory and selected fault arguments',
    }

    def record():
        (evidence / 'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))

    def run(command):
        item = {'command': list(map(str, command))}
        results['commands'].append(item)
        record()
        process = subprocess.run(command, text=True, capture_output=True, timeout=90)
        item.update({'exit': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr})
        record()
        assert process.returncode == 0, item
        return process

    original_project = evidence / 'original-portable-constructor'
    (original_project / 'src/app').mkdir(parents=True)
    for name in ['etas.toml', 'src/app/main.es']:
        shutil.copyfile(ROOT / 'examples/repros/ETAS-0013' / name, original_project / name)
    run([str(CLI), 'check', '--all', str(original_project)])
    original_run = run([str(CLI), 'run', str(original_project), '--allow-effects'])
    assert original_run.stdout == 'PUBLIC_CONSTRUCTOR_OK\n', original_run.stdout
    results['completed'].append('original-portable-constructor')
    record()
    print('PASS fixed original portable constructor (historical observer not invoked)', flush=True)
    # Constructor-only controls use a synthetic token. Passing it to preparation
    # would correctly fail version validation; real preparations below use SQLite versions.
    prepare = '    let condition = CONDITION;'
    cases = [
        ('version-control', '', '    if observed.opaque != "synthetic-version-only-not-backend-evidence" { return 1; }'),
        ('missing-control', 'import std.memory.Missing;', prepare.replace('CONDITION', 'Missing')),
        ('imported-match', 'import std.memory.Match;', prepare.replace('CONDITION', 'Match(observed)')),
        ('qualified-match', '', prepare.replace('CONDITION', 'std.memory.Match(observed)')),
        ('type-qualified-match', 'import std.memory.WriteCondition;', prepare.replace('CONDITION', 'WriteCondition.Match(observed)')),
        ('fully-type-qualified-match', '', prepare.replace('CONDITION', 'std.memory.WriteCondition.Match(observed)')),
    ]
    for name, imports, expression in cases:
        project = evidence / name
        (project / 'src/app').mkdir(parents=True)
        (project / 'etas.toml').write_text(MANIFEST)
        (project / 'src/app/main.es').write_text(source(imports, expression).replace(
            'PUBLIC_CONSTRUCTOR_AND_PREPARATION_OK', 'FIXED_CONSTRUCTOR_OK'))
        run([str(CLI), 'check', '--all', str(project)])
        execution = run([str(CLI), 'run', str(project), '--allow-effects'])
        assert execution.stdout == 'FIXED_CONSTRUCTOR_OK\n', execution.stdout
        assert 'InvalidArguments' not in execution.stderr
        results['completed'].append(name)
        record()
        print('PASS fixed ' + name, flush=True)

    project = evidence / 'prepared-publication'
    (project / 'src/nomo').mkdir(parents=True)
    (project / 'src/app').mkdir()
    for name in PRODUCT:
        shutil.copyfile(ROOT / 'packages/session-store/src/nomo' / name, project / 'src/nomo' / name)
    for name in SHARED:
        shutil.copyfile(ROOT / 'src/nomo' / name, project / 'src/nomo' / name)
    (project / 'etas.toml').write_text(MANIFEST)
    # Only this generated copy changes: exercise prepare/commit Match plus exact
    # returned-version and payload readback, retaining the repository workaround.
    adapter = project / 'src/nomo/metadata_store.es'
    original = adapter.read_text()
    old = '    put_versioned(Metadata.Rows, row.snapshot.session_id, row, expected);'
    assert original.count(old) == 1
    replacement = ('    let committed = match write(row, std.memory.Match(expected)) {\n'
                   '        Ok(version) => version, Err(error) => { return Err(error); }\n'
                   '    };')
    modified = original.replace(old, replacement)
    old_check = 'observed.version.opaque == expected.opaque {'
    assert modified.count(old_check) == 1
    modified = modified.replace(old_check, 'observed.version.opaque == expected.opaque || observed.version.opaque != committed.opaque {')
    adapter.write_text(modified)
    (evidence / 'original-metadata-store.es').write_text(original)
    results['replacement'] = {'original_sha256': hashlib.sha256(original.encode()).hexdigest(),
                              'replacement_sha256': digest(adapter), 'repository_changed': False}
    results['product_copy'] = {str(p.relative_to(project)): digest(p) for p in (project / 'src/nomo').glob('*.es')}
    for mode in ['stub', 'text-model', 'scripted-read']:
        fixture = fixture_source(mode).replace('    match result {', '    println("AFTER_STORE_CALL");\n    match result {')
        entry = project / 'src/app/main.es'
        entry.write_text(fixture)
        (evidence / (mode + '-entry.es')).write_text(fixture)
        run([str(CLI), 'check', '--all', str(project)])
        for fault in ['none', 'conflict', 'publish', 'publish-readback']:
            database = project / (mode + '-' + fault)
            database.mkdir()
            session_id, save_id = mode + '-' + fault, 'save1'
            bodies = ['same', '', '雪😀"\\\n\r\t\0same']
            payload = json.dumps(['nomo-session-bundle-v1', session_id, save_id, *bodies], ensure_ascii=False)

            def invoke(action, selected_fault):
                command = [str(HOST), str(project / 'src'), 'app.main', 'main', str(database), selected_fault,
                           action, session_id, save_id, payload]
                observation = json.loads(run(command).stdout)
                assert observation['denied_services'] == observation['denied_writes'] == observation['writes_after_fault'] == 0
                results['commands'][-1]['entry_sha256'] = digest(entry)
                record()
                return observation

            setup = invoke('setup', 'none')
            assert setup['stdout'] == 'SETUP_EMPTY\n' and setup['diagnostics'] == [], setup
            saved = invoke('save', fault)
            assert saved['diagnostics'] == [], saved
            assert saved['stdout'].startswith(MARKER), saved
            output = saved['stdout'].removeprefix(MARKER)
            assert saved['memory_mutations'] == 2 and saved['session_appends'] == saved['session_resolves'] == 1, saved
            row, version, count = stored(database)
            assert count == 1
            wanted = plain(snapshot(mode))
            wanted['session_id'] = session_id
            wanted['history']['characters'] = expected(mode, session_id, bodies)['history']['characters']
            for event in wanted['history']['events']:
                event['text'] = ''
            assert row['snapshot'] == wanted, ('stored ledger or descriptors changed', row, wanted)
            if fault == 'none':
                assert not saved['fault_fired'] and json.loads(output) == expected(mode, session_id, bodies), saved
                assert version == 2 and row['phase'] == 'published'
            elif fault == 'conflict':
                assert saved['fault_fired'] and saved['fixture_mutations'] == 1, saved
                assert any(event.get('actual_sqlite_cas_conflict') for event in saved['trace']), saved
                assert output == 'REFUSED metadata commit refused; no retry\n', saved
                assert version == 2 and row['phase'] == 'pending'
                assert saved['post_fault_reads'] == 0
            elif fault == 'publish':
                assert saved['fault_fired'], saved
                losses = [e for e in saved['trace'] if e.get('acknowledgement_dropped')]
                assert len(losses) == 1 and losses[0]['actual_sqlite_commit'], saved
                assert output == 'REFUSED metadata commit unknown; no retry\n', saved
                assert saved['post_fault_reads'] == 0 and version == 2 and row['phase'] == 'published'
            else:
                assert saved['fault_fired'] and saved['fixture_mutations'] == 1, saved
                assert output == 'REFUSED published metadata readback mismatch\n', saved
                assert version == 3 and row['save_id'] == 'competing-save-marker'
            before = contents(database)
            loaded = invoke('load', 'read-only')
            assert loaded['diagnostics'] == [] and loaded['stdout'].startswith(MARKER), loaded
            assert loaded['memory_mutations'] == loaded['session_appends'] == loaded['session_resolves'] == 0, loaded
            assert contents(database) == before, 'read-only reload changed database contents'
            output = loaded['stdout'].removeprefix(MARKER)
            if fault in ('none', 'publish'):
                assert json.loads(output) == expected(mode, session_id, bodies), loaded
            elif fault == 'conflict':
                assert output == 'REFUSED pending save; recovery required; no retry\n', loaded
            else:
                assert output == 'REFUSED metadata identity mismatch\n', loaded
            results['completed'].append(mode + ':' + fault)
            record()
            print('PASS fixed prepared publication ' + mode + ':' + fault, flush=True)
    assert all(digest(Path(path)) == fingerprint for path, fingerprint in protected.items())
    results['status'] = 'PASS original portable constructor, six fixed call-form controls and 12 real prepared-publication cases'
    record()
    print(results['status'], flush=True)


if __name__ == '__main__':
    main()
