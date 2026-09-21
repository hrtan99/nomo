#!/usr/bin/env python3
"""Synthetic, disposable CLI artifacts/policy/deployment checks for ETAS-013."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path('/workspace')
BASE = Path('/validation')
OLD = '/home/nomo/.cargo/bin/etas'
NEW = '/validation/target/debug/etas'


def hashes(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


class Probe:
    def __init__(self, mode):
        self.root = Path(tempfile.mkdtemp(prefix=f'blackbox-{mode}-', dir=BASE))
        self.rows = []
        (self.root / 'binary.sha256').write_text(hashlib.sha256(Path(NEW).read_bytes()).hexdigest() + '\n')

    def run(self, label, argv, *, env=None):
        result = subprocess.run(argv, cwd=self.root, capture_output=True, text=True,
                                timeout=20, env=env)
        row = dict(case=label, command=list(map(str, argv)), exit=result.returncode,
                   stdout=result.stdout, stderr=result.stderr, status='OBSERVED')
        self.rows.append(row)
        self.save()
        return result

    def save(self):
        (self.root / 'results.json').write_text(json.dumps(self.rows, indent=2) + '\n')

    def expect(self, condition):
        self.rows[-1]['status'] = 'PASS' if condition else 'FAIL'
        self.save()
        assert condition, self.rows[-1]
        print('PASS', self.rows[-1]['case'], flush=True)

    def artifacts(self):
        project = self.root / 'project'
        shutil.copytree(ROOT / 'tests/fixtures/etas007/checkpoint_project', project)
        source_before = hashes(project)
        legacy = self.root / 'legacy-v18'
        result = self.run('P12-02.produce-real-v18', [OLD, 'run', str(project),
                          '--allow-effects', '--checkpoint-dir', str(legacy)])
        self.expect(result.returncode == 0 and 'BEFORE\nAFTER\n' in result.stdout)
        original = legacy / 'checkpoint-0.json'
        assert json.loads(original.read_text())['schema'] == 'etas.cli.interpreter-checkpoint.v18'
        legacy_before = hashes(legacy)
        copied = self.root / 'legacy-copy'
        shutil.copytree(legacy, copied)
        result = self.run('P12-02.refuse-real-v18', [NEW, 'resume', '0', '--checkpoint-dir', str(copied)])
        # The CLI validates the current profile before decoding checkpoint payloads.
        refusal = result.stdout + result.stderr
        self.expect(result.returncode != 0 and ('schema' in refusal.lower() or
                    'current host runtime profile is not compatible with the checkpoint' in refusal)
                    and 'AFTER\n' not in result.stdout and hashes(copied) == legacy_before)
        fresh = self.root / 'fresh-v32'
        result = self.run('P12-02.produce-real-v32', [NEW, 'run', str(project),
                          '--allow-effects', '--checkpoint-dir', str(fresh)])
        self.expect(result.returncode == 0 and 'BEFORE\nAFTER\n' in result.stdout)
        artifact = json.loads((fresh / 'checkpoint-0.json').read_text())
        assert artifact['schema'] == 'etas.cli.interpreter-checkpoint.v32'
        result = self.run('P12-02.resume-real-v32', [NEW, 'resume', '0', '--checkpoint-dir', str(fresh)])
        self.expect(result.returncode == 0 and 'AFTER\n' in result.stdout and 'BEFORE\n' not in result.stdout)
        for version in [30, 31, 999]:
            target = self.root / f'schema-negative-{version}'
            target.mkdir()
            changed = dict(artifact, schema=f'etas.cli.interpreter-checkpoint.v{version}')
            (target / 'checkpoint-0.json').write_text(json.dumps(changed))
            before = hashes(target)
            result = self.run(f'P12-02.schema-only-v{version}-negative',
                              [NEW, 'resume', '0', '--checkpoint-dir', str(target)])
            self.expect(result.returncode != 0 and 'schema' in (result.stdout + result.stderr).lower()
                        and 'AFTER\n' not in result.stdout and hashes(target) == before)
        corrupt = self.root / 'corrupt-json'
        corrupt.mkdir()
        (corrupt / 'checkpoint-0.json').write_text('{')
        before = hashes(corrupt)
        result = self.run('P12-02.corrupt-json', [NEW, 'resume', '0', '--checkpoint-dir', str(corrupt)])
        self.expect(result.returncode != 0 and 'not valid JSON' in result.stderr
                    and not result.stdout and hashes(corrupt) == before)
        before = hashes(fresh)
        result = self.run('P12-02.stricter-current-depth-refusal',
                          [NEW, 'resume', '0', '--checkpoint-dir', str(fresh), '--max-call-depth', '1'])
        self.expect(result.returncode != 0 and 'profile is not compatible' in result.stderr
                    and not result.stdout and hashes(fresh) == before)
        assert hashes(legacy) == legacy_before and hashes(project) == source_before
        self.cache()
        assert hashes(legacy) == legacy_before and hashes(project) == source_before

    def cache(self):
        project = self.root / 'project'
        if not project.exists():
            shutil.copytree(ROOT / 'tests/fixtures/etas007/checkpoint_project', project)
        cache = self.root / 'cache-v2-original'
        result = self.run('P12-01.produce-v2-cache', [OLD, 'check', str(project),
                          '--cache', 'read-write', '--cache-root', str(cache)])
        self.expect(result.returncode == 0 and self.versions(cache) == {2})
        cache_before = hashes(cache)
        mixed = self.root / 'cache-v2-copy'
        shutil.copytree(cache, mixed)
        for name, directory in [('recompute-v2-copy', mixed), ('fresh-v3', self.root / 'cache-v3'),
                                ('cached-v3', self.root / 'cache-v3')]:
            result = self.run('P12-01.' + name, [NEW, 'check', str(project),
                              '--cache', 'read-write', '--cache-root', str(directory)])
            versions = self.versions(directory)
            self.rows[-1]['cache_versions'] = sorted(versions)
            self.expect(result.returncode == 0 and
                        (3 in versions if directory == mixed else versions == {3}))
        # Serialized caches contain reuse bookkeeping; do not invent byte equality as a contract.
        self.rows.append(dict(case='P12-01.cache-artifact-comparison', status='OBSERVATION',
                              mixed_v3_rows=len(self.cache_rows(mixed, 3)),
                              fresh_v3_rows=len(self.cache_rows(self.root / 'cache-v3', 3)),
                              byte_equal=self.cache_rows(mixed, 3) == self.cache_rows(self.root / 'cache-v3', 3)))
        self.save()
        for operation in ['effects', 'run']:
            outputs = []
            for directory in [mixed, self.root / 'cache-v3']:
                result = self.run(f'P12-01.{operation}-{directory.name}',
                                  [NEW, operation, str(project), '--cache', 'read-write',
                                   '--cache-root', str(directory)] + (['--allow-effects'] if operation == 'run' else []))
                self.expect(result.returncode == 0 and not result.stderr)
                outputs.append(result.stdout)
            self.rows.append(dict(case=f'P12-01.{operation}-semantic-agreement', status='OBSERVED'))
            self.expect(outputs[0] == outputs[1] and
                        (outputs[0] == 'BEFORE\nAFTER\n' if operation == 'run' else 'Console' in outputs[0]))
        assert hashes(cache) == cache_before

    @staticmethod
    def cache_rows(root, version):
        with sqlite3.connect(f'file:{root / "v1/cache.sqlite"}?mode=ro', uri=True) as db:
            return sorted(db.execute('select key,fingerprint,payload_hash from artifacts where cache_schema_version=?', (version,)))

    @staticmethod
    def versions(root):
        versions = set()
        for path in root.rglob('*'):
            if path.is_file() and path.read_bytes()[:16] == b'SQLite format 3\x00':
                with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
                    versions.update(row[0] for row in db.execute('select cache_schema_version from artifacts'))
        return versions

    def policy(self):
        project = self.root / 'project'
        shutil.copytree(ROOT / 'tests/fixtures/etas007/checkpoint_project', project)
        source = project / 'src/app/main.es'
        shutil.copyfile(ROOT / 'tests/fixtures/etas013/policy.es', source)
        result = self.run('P12-04.policy-check', [NEW, 'check', str(project)])
        self.expect(result.returncode == 0)
        result = self.run('P12-04.policy-effects', [NEW, 'effects', str(project)])
        self.expect(result.returncode == 0 and 'Memory.write' not in result.stdout)
        result = self.run('P12-04.policy-source-branches', [NEW, 'run', str(project), '--allow-effects'])
        alias_ok = self.markers(result)
        self.rows[-1]['status'] = 'PASS' if alias_ok else 'FAIL'
        self.save()
        # Keep the bare-constructor case intact. Upstream storage_outcomes.rs uses ().
        canonical = self.root / 'invoked-project'
        shutil.copytree(project, canonical)
        text = source.read_text()
        for variant in ['Unresolved', 'Expired']:
            text = text.replace('Lookup.' + variant, 'Lookup.' + variant + '()')
        (canonical / 'src/app/main.es').write_text(text)
        result = self.run('P12-04.invoked-policy-control',
                          [NEW, 'run', str(canonical), '--allow-effects'])
        self.expect(self.markers(result))
        assert alias_ok, 'bare standard nullary construction remains a failing source-contract case'

    @staticmethod
    def markers(result):
        return (result.returncode == 0 and result.stdout.count('COMMITTED_MARKER\n') == 1
                and result.stdout.count('RECONCILED_MARKER\n') == 1 and 'UNSAFE_' not in result.stdout)

    def deployment(self):
        project = self.root / 'project'
        shutil.copytree(ROOT / 'tests/fixtures/etas007/checkpoint_project', project)
        manifest = project / 'etas.toml'
        manifest.write_text(manifest.read_text().replace('["console=allow"]', '["console=allow", "command=allow"]'))
        source = project / 'src/app/main.es'
        source.write_text('''module app.main;
import std.io.println;
import std.host.command.{command, run};
flow main(args: Array<string>) -> i32 ![Console, Error<IOError>, Command.run<DefaultCommandSandbox>] {
    let result = run(command("/bin/echo", ["COMMAND_MARKER"]), DefaultCommandSandbox);
    println("FOLLOWING_MARKER");
    return 0;
}
''')
        result = self.run('P12-09.command-source-check', [NEW, 'check', str(project)])
        self.expect(result.returncode == 0)
        env = {k: v for k, v in os.environ.items() if not k.startswith('ETAS_HOST_')}
        env['ETAS_HOST_COMMAND_ALLOWLIST'] = '/bin/echo'
        for backend in [None, 'not-a-backend', 'container', 'wasi-preopen']:
            current = dict(env)
            if backend:
                current['ETAS_HOST_COMMAND_ISOLATION'] = backend
            result = self.run(f'P12-09.profile-refusal-{backend}',
                              [NEW, 'run', str(project), '--allow-effects'], env=current)
            expected = ('explicit isolation' if backend is None else
                        'unknown command isolation' if backend == 'not-a-backend' else
                        'isolation backend is unavailable')
            self.expect(result.returncode != 0 and 'MARKER\n' not in result.stdout
                        and expected in result.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['artifacts', 'cache', 'policy', 'deployment'])
    args = parser.parse_args()
    probe = Probe(args.mode)
    print('evidence:', probe.root, flush=True)
    getattr(probe, args.mode)()


if __name__ == '__main__':
    main()
