#!/usr/bin/env python3
"""Build/run additional bounded Host fixtures using the already provisioned graph."""
import importlib.util
import json
from pathlib import Path
import shutil

SPEC = importlib.util.spec_from_file_location('graph', Path(__file__).with_name('etas-013-isolated.py'))
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)
ROOT = Path('/validation')
FIXTURE = Path('/workspace/tests/fixtures/etas013/host_probe')


def main():
    GRAPH.guard()
    project = ROOT / 'host-probe'
    if not project.exists():
        shutil.copytree(FIXTURE, project)
        shutil.copyfile(ROOT / 'core/Cargo.lock', project / 'Cargo.lock')
        (ROOT / 'host-probe-overrides.toml').write_text('\n')
        GRAPH.cargo('host-probe', 'metadata', '--format-version', '1', '--offline')
        GRAPH.save('host-probe-lock.json', {'sha256': GRAPH.digest(project / 'Cargo.lock')})
    for source in FIXTURE.rglob('*'):
        if source.is_file():
            assert GRAPH.digest(source) == GRAPH.digest(project / source.relative_to(FIXTURE))
    assert (ROOT / 'host-probe-overrides.toml').read_text() == '\n'
    locked = json.loads((ROOT / 'host-probe-lock.json').read_text())['sha256']
    assert GRAPH.graph('host-probe', True) == locked
    output = GRAPH.run(['cargo', 'test', '--offline', '--locked', '--manifest-path',
                        str(project / 'Cargo.toml'), '--', '--nocapture', '--test-threads=1'], timeout=180)
    (ROOT / 'host-probe-test.log').write_text(output)
    print(output, end='')
    assert 'test result: ok. 5 passed; 0 failed; 0 ignored;' in output
    assert GRAPH.digest(project / 'Cargo.lock') == locked
    GRAPH.guard()


if __name__ == '__main__':
    main()
