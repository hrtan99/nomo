#!/usr/bin/env python3
"""Retain unchanged full-root affected checks, using the explicit static helper."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import hashlib

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    evidence = Path(tempfile.mkdtemp(prefix='continue-regressions-', dir=os.environ['NOMO_TEST_EVIDENCE']))
    print('EVIDENCE ' + str(evidence), flush=True)
    selected = list((ROOT / 'src').rglob('*.es')) + list((ROOT / 'tests').rglob('*.py')) + list((ROOT / 'scripts').glob('*'))
    selected += [ROOT / name for name in ('etas.toml', 'etas.lock', 'compose.yaml', 'patches/etas-003/Cargo.lock',
                  'config/etas-latest-main.json',
                  'config/etas-runtime-cache-compose.yaml', 'tests/fixtures/etas013/compose.yaml',
                  'tests/fixtures/session_continue/static-check-compose.yaml',
                  *(f'patches/etas-0013/{name}.Cargo.lock' for name in ('core', 'frontend', 'interpreter', 'cli')))]
    selected = [p for p in selected if p.is_file()]
    before = {str(p.relative_to(ROOT)): digest(p) for p in selected}
    for p in selected:
        target = evidence / 'inputs' / p.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target)
    spec = importlib.util.spec_from_file_location('state_probe', ROOT / 'tests/session_state_probe.py')
    state = importlib.util.module_from_spec(spec)
    # Import-only use below retains the exact generated batch inputs independently.
    import sys
    sys.path.insert(0, str(ROOT / 'tests'))
    spec.loader.exec_module(state)
    fixtures = evidence / 'validator-fixtures'
    fixtures.mkdir()
    cases = state.cases()
    for offset in range(0, len(cases), 12):
        (fixtures / (str(offset) + '.es')).write_text(state.fixture(cases[offset:offset + 12]))
    result = {'status': 'running', 'sources_before': before, 'commands': [],
              'helper_memory_max': Path('/sys/fs/cgroup/memory.max').read_text(),
              'validator_scope': 'same unmodified full-root 152-case driver and 5 typed-field refusals; complete product checks remain in the original chain',
              'validator_inputs': {str(p.relative_to(evidence)): digest(p) for p in fixtures.iterdir()}}
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', SESSION_STORE_GRAPH='/home/nomo/.cargo/etas-latest',
                       ETAS='/home/nomo/.cargo/bin/etas', NOMO_TEST_EVIDENCE=str(evidence))
    commands = [['python3', '-B', str(ROOT / 'tests/session_cli_mapping_probe.py')],
                ['python3', '-B', str(ROOT / 'tests/session_state_probe.py')], ['python3', '-B', str(ROOT / 'scripts/tool-001a-verify.py')]]

    def record():
        (evidence / 'results.json').write_text(json.dumps(result, indent=2))

    try:
        for command in commands:
            item = {'command': command}
            result['commands'].append(item)
            record()
            process = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=600)
            item.update(exit=process.returncode, stdout=process.stdout, stderr=process.stderr)
            record()
            print(process.stdout, end='', flush=True)
            assert process.returncode == 0, (command, process.returncode, process.stderr[:4000], str(evidence))
        result['sources_after'] = {name: digest(ROOT / name) for name in before}
        assert result['sources_after'] == before
        result['status'] = 'passed'
        record()
        print('PASS retained affected regressions', flush=True)
    except BaseException:
        result['status'] = 'failed'
        record()
        raise


if __name__ == '__main__':
    main()
