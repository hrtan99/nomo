#!/usr/bin/env python3
"""Verify the opt-in stub entry on the retained, accepted isolated storage graph."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BASE = Path('/validation')
SPEC = importlib.util.spec_from_file_location('store_verification', ROOT / 'scripts/session-store-001a-verify.py')
STORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STORE)
PROBES = ['session_cli_mapping_probe.py', 'session_cli_probe.py']


def sources():
    result = STORE.source_hashes()
    for name in ['scripts/session-cli-001a-verify.py', *('tests/' + name for name in PROBES)]:
        result[name] = STORE.digest(ROOT / name)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--section', choices=['all', 'arguments', 'roundtrip', 'state'], default='all',
                        help='entry checks to run; mapping/display checks always run')
    options = parser.parse_args()
    assert BASE.is_dir() and BASE.resolve() == BASE, 'required /validation graph missing'
    evidence = Path(tempfile.mkdtemp(prefix='session-cli-verification-', dir=BASE))
    print('EVIDENCE ' + str(evidence), flush=True)
    summary = {'status': 'running', 'commands': [],
               'entry_section': options.section,
               'environment': 'accepted isolated storage graph; not normal ETAS-011 or merged-fix graph',
               'scope': 'fixture-provisioned, opt-in stub save/show only; no resume or default activation',
               'separate_regressions': ['scripts/session-store-001a-verify.py on accepted storage graph',
                                        STORE.ACCEPTED_COMMAND]}

    def save():
        (evidence / 'results.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False))

    def run(command, *, cwd=ROOT, timeout=180):
        print('+ ' + ' '.join(map(str, command)), flush=True)
        item = {'command': list(map(str, command)), 'cwd': str(cwd), 'timeout': timeout}
        summary['commands'].append(item)
        save()
        try:
            result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                                    env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
        except subprocess.TimeoutExpired as error:
            item.update({'timeout_expired': True, 'stdout': str(error.stdout or ''), 'stderr': str(error.stderr or '')})
            save()
            raise
        item.update({'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
        save()
        if result.stdout:
            print(result.stdout, end='', flush=True)
        if result.stderr:
            print(result.stderr, end='', file=sys.stderr, flush=True)
        assert result.returncode == 0, ('unexpected exit', item)
        return result

    try:
        summary['sources_before'] = sources()
        for name, fingerprint in summary['sources_before'].items():
            retained = evidence / 'workspace-inputs' / name
            retained.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, retained)
            assert STORE.digest(retained) == fingerprint, ('input changed during copy', name)
        summary['provenance'] = STORE.guard(run)
        save()
        for name, timeout in zip(PROBES, [360, 1800]):
            arguments = ['--section', options.section] if name == 'session_cli_probe.py' else []
            run(['python3', '-B', str(ROOT / 'tests' / name), *arguments], timeout=timeout)
        run(['python3', '-B', str(ROOT / 'scripts/count-sloc.py')])
        summary['sources_after'] = sources()
        assert summary['sources_after'] == summary['sources_before'], 'source changed during verification'
        assert STORE.digest(STORE.CLI) == summary['provenance']['binary']['sha256']
        host = BASE / 'target/debug/nomo-session-store-host-faults'
        assert STORE.digest(host) == summary['provenance']['host_fixture']['fixture_binary_sha256']
        summary['status'] = 'isolated entry verification passed'
        print('PASS isolated stub entry verification (' + options.section +
              '); storage and normal regressions are separate', flush=True)
    except BaseException as error:
        summary['status'] = 'failed'
        summary['failure'] = repr(error)
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
