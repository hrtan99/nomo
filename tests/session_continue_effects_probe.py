#!/usr/bin/env python3
"""Capture full-root generated-fixture effects diagnostics and cgroup memory events."""
import argparse
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import tempfile
import time

from normal_graph_identity import digest, verify_cli
from session_state_probe import cases, fixture

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', type=Path)
    args = parser.parse_args()
    cli = verify_cli()
    evidence = Path(tempfile.mkdtemp(prefix='effects-memory-', dir=os.environ['NOMO_TEST_EVIDENCE']))
    if args.fixture:
        project = args.fixture
        assert project.is_dir() and project.resolve().is_relative_to(Path(os.environ['NOMO_TEST_EVIDENCE']).resolve())
    else:
        project = evidence / 'project'
        shutil.copytree(ROOT / 'src', project / 'src')
        shutil.copyfile(ROOT / 'etas.lock', project / 'etas.lock')
        (project / 'etas.toml').write_text((ROOT / 'etas.toml').read_text().replace('module = "nomo.main"', 'module = "nomo.session_fixture"'))
        (project / 'src/nomo/session_fixture.es').write_text(fixture(cases()[:12]))
    print('FIXTURE ' + str(project), flush=True)
    print('EVIDENCE ' + str(evidence), flush=True)
    sources = {str(p.relative_to(project)): digest(p) for p in project.rglob('*') if p.is_file()}
    for p in project.rglob('*'):
        if p.is_file():
            target = evidence / 'inputs' / p.relative_to(project)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
    shutil.copyfile(__file__, evidence / 'driver.py')
    command = [str(cli), 'effects', str(project), '--flow', 'pure_probe']
    events = Path('/sys/fs/cgroup/memory.events')
    before = events.read_text()
    started = time.monotonic()
    process = subprocess.run(command, capture_output=True, text=True, timeout=120)
    report = {'command': command, 'exit': process.returncode, 'elapsed_seconds': time.monotonic() - started,
              'stdout': process.stdout, 'stderr': process.stderr, 'sources': sources,
              'memory_events_before': before, 'memory_events_after': events.read_text(),
              'memory_max': Path('/sys/fs/cgroup/memory.max').read_text(),
              'child_usage': list(resource.getrusage(resource.RUSAGE_CHILDREN)), 'cli_sha256': digest(cli),
              'driver_sha256': digest(evidence / 'driver.py')}
    assert {str(p.relative_to(project)): digest(p) for p in project.rglob('*') if p.is_file()} == sources
    (evidence / 'results.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({key: report[key] for key in ('exit', 'elapsed_seconds', 'memory_max', 'memory_events_before', 'memory_events_after', 'child_usage')}, indent=2), flush=True)


if __name__ == '__main__':
    main()
