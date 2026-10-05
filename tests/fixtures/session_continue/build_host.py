#!/usr/bin/env python3
"""Test-only real process-kill boundaries on the pinned SQLite Host, outside its cache."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import hashlib

ROOT = Path(__file__).resolve().parents[3]
GRAPH = Path('/home/nomo/.cargo/etas0013')
EVIDENCE = Path(os.environ['NOMO_TEST_EVIDENCE'])


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


PAUSE = '''    fn continuation_pause(&self, point: &str) {
        if std::env::var("NOMO_CONTINUE_PAUSE").ok().as_deref() != Some(point) { return; }
        let marker = std::env::var("NOMO_CONTINUE_MARKER").expect("owned marker required");
        let snapshot = json!({"point":point,
            "memory_mutations":self.memory_mutations.load(Ordering::SeqCst),
            "session_resolves":self.session_resolves.load(Ordering::SeqCst),
            "session_appends":self.session_appends.load(Ordering::SeqCst),
            "trace":*self.trace.lock().unwrap(), "stdout":*self.stdout.lock().unwrap()});
        std::fs::write(marker, serde_json::to_vec(&snapshot).unwrap()).unwrap();
        loop { std::thread::park(); }
    }

'''


def transform(source):
    substitutions = [
        ('    fn before_write(&self, kind: &str)', PAUSE + '    fn before_write(&self, kind: &str)'),
        ('            let ordinal = self.memory_reads.fetch_add(1, Ordering::SeqCst) + 1;',
         '''            let ordinal = self.memory_reads.fetch_add(1, Ordering::SeqCst) + 1;
            if !self.fault_fired.load(Ordering::SeqCst) && self.memory_mutations.load(Ordering::SeqCst) > 0 &&
                std::env::var("NOMO_CONTINUE_READBACK").ok().as_deref() == Some(self.memory_mutations.load(Ordering::SeqCst).to_string().as_str()) {
                self.competing_write(request.clone(), true).await?;
            }'''),
        ('            let response = self.memory.write_scoped(request, &operation).await?;',
         '''            if ordinal == 1 { self.continuation_pause("before-fence-dispatch"); }
            if ordinal == 2 { self.continuation_pause("before-admission-dispatch"); }
            if ordinal == 3 { self.continuation_pause("before-publication"); }
            if std::env::var("NOMO_CONTINUE_REJECT").ok().as_deref() == Some(if ordinal == 1 { "fence" } else if ordinal == 2 { "admission" } else { "publication" }) {
                assert!(!self.fault_fired.swap(true, Ordering::SeqCst));
                self.trace.lock().unwrap().push(json!({"kind":"memory", "ordinal":ordinal,
                    "actual_sqlite_commit":false, "provider_unavailable_before_dispatch":true}));
                return Err(HostError::new(HostErrorCode::ProviderUnavailable, "test uncommitted write failure"));
            }
            let response = self.memory.write_scoped(request, &operation).await?;'''),
        ('            if self.fault == "conflict" && ordinal == 2 && !conflict {',
         '''            if ordinal == 1 { self.continuation_pause("after-fence-commit"); }
            if ordinal == 2 { self.continuation_pause("after-admission-commit"); }
            if ordinal == 3 { self.continuation_pause("after-publication-commit"); }
            if ordinal == 3 && std::env::var("NOMO_CONTINUE_LOSS").ok().as_deref() == Some("publication") {
                assert!(committed);
                return Err(self.drop_ack("memory", ordinal));
            }
            if self.fault == "conflict" && ordinal == 2 && !conflict {'''),
        ('            self.before_write(kind)?;',
         '''            if !append && self.session_resolves.load(Ordering::SeqCst) == 1 {
                self.continuation_pause("after-admission-before-initialize");
            }
            if append { self.continuation_pause("before-append"); }
            self.before_write(kind)?;'''),
        ('            if append && self.fault == "append" {',
         '''            if !append && self.session_resolves.load(Ordering::SeqCst) == 1 {
                self.continuation_pause("after-initialize");
            }
            if append { self.continuation_pause("after-append"); }
            if !append && std::env::var("NOMO_CONTINUE_LOSS").ok().as_deref() == Some(if self.session_resolves.load(Ordering::SeqCst) == 1 { "initialize" } else { "append-binding" }) {
                assert!(committed);
                return Err(self.drop_ack("resolve", self.session_resolves.load(Ordering::SeqCst)));
            }
            if append && self.fault == "append" {'''),
        ('            if newline { output.push(\'\\n\'); }',
         '''            if newline { output.push('\\n'); }
            drop(output);
            if text.starts_with("model: tool ") { self.continuation_pause("during-turn"); }'''),
    ]
    for old, new in substitutions:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    return source


def main():
    assert EVIDENCE.is_dir() and not EVIDENCE.resolve().is_relative_to(GRAPH)
    mount = next(line for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == '/home/nomo/.cargo')
    assert 'ro' in mount.split()[5].split(',')
    bootstrap_path = ROOT / 'scripts/etas-0013-cli-bootstrap.py'
    spec = importlib.util.spec_from_file_location('normal_bootstrap', bootstrap_path)
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    cli = bootstrap.verify(read_only=True)
    base_identity = json.loads((GRAPH / 'host-faults-identity.json').read_text())
    base = ROOT / 'tests/fixtures/session_store/host_faults'
    assert {p: digest(base / p) for p in base_identity['fixture_source_sha256']} == base_identity['fixture_source_sha256']
    protected = {str(p): digest(p) for p in (GRAPH / 'binary.json', GRAPH / 'identity.json',
        GRAPH / 'target/debug/nomo-session-store-host-faults', GRAPH / 'host-faults/Cargo.lock',
        *(GRAPH / 'src' / name / 'Cargo.lock' for name in ('core', 'frontend', 'interpreter', 'cli')))}
    directory = Path(tempfile.mkdtemp(prefix='continue-host-build-', dir=EVIDENCE))
    print('EVIDENCE ' + str(directory), flush=True)
    fixture = directory / 'host-faults'
    shutil.copytree(base, fixture)
    shutil.copyfile(GRAPH / 'host-faults/Cargo.lock', fixture / 'Cargo.lock')
    source = fixture / 'src/main.rs'
    (directory / 'original-main.rs').write_text(source.read_text())
    source.write_text(transform(source.read_text()))
    shutil.copyfile(__file__, directory / 'driver.py')
    shutil.copyfile(bootstrap_path, directory / 'normal_bootstrap.py')
    report = {'base_identity': base_identity, 'protected_graph': protected, 'verified_cli': cli,
              'cache_mount': mount, 'commands': [], 'recipe_sha256': digest(directory / 'driver.py')}
    environment = dict(os.environ, CARGO_TARGET_DIR=str(directory / 'target'))
    common = ['--offline', '--locked', '--manifest-path', str(fixture / 'Cargo.toml'), '--config', str(GRAPH / 'cli-overrides.toml')]

    def run(args):
        item = {'command': args}
        report['commands'].append(item)
        process = subprocess.run(args, text=True, capture_output=True, env=environment, timeout=1200)
        item.update(exit=process.returncode, stdout=process.stdout, stderr=process.stderr)
        (directory / 'build-results.json').write_text(json.dumps(report, indent=2))
        assert process.returncode == 0, item
        return process.stdout

    metadata = json.loads(run(['cargo', 'metadata', '--format-version', '1', *common]))
    approved = {(p['name'], p['version'], p['source']) for p in json.loads((GRAPH / 'cli-metadata.json').read_text())['packages']}
    origins = {}
    for p in metadata['packages']:
        if p['name'] == 'nomo-session-store-host-faults':
            assert p['manifest_path'] == str(fixture / 'Cargo.toml')
        else:
            assert (p['name'], p['version'], p['source']) in approved, p
            if p['name'].startswith('etas_'):
                assert p['source'] is None
                origins[p['name']] = p['manifest_path']
    assert origins == json.loads((GRAPH / 'host-faults-origins.json').read_text())
    (directory / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    (directory / 'origins.json').write_text(json.dumps(origins, indent=2))
    run(['cargo', 'build', *common])
    binary = directory / 'target/debug/nomo-session-store-host-faults'
    assert {p: digest(Path(p)) for p in protected} == protected
    assert digest(fixture / 'Cargo.lock') == base_identity['fixture_lock_sha256']
    identity = {'base_identity': base_identity, 'binary': str(binary), 'binary_sha256': digest(binary),
                'sources': {str(p.relative_to(directory)): digest(p) for p in (
                    source, fixture / 'Cargo.toml', fixture / 'Cargo.lock', directory / 'driver.py',
                    directory / 'original-main.rs', directory / 'normal_bootstrap.py', directory / 'metadata.json', directory / 'origins.json')},
                'verified_cli': cli, 'protected_graph': protected}
    (directory / 'identity.json').write_text(json.dumps(identity, indent=2))
    print('PASS continuation observer ' + str(directory / 'identity.json'), flush=True)


if __name__ == '__main__':
    main()
