#!/usr/bin/env python3
"""Run bounded, layer-labelled ETAS-013 suites without modifying upstream tests."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import time

SPEC = importlib.util.spec_from_file_location('isolated', Path(__file__).with_name('etas-013-isolated.py'))
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)
ROOT = Path('/validation')


def cases(phase):
    if phase == 'source':
        yield 'P12-01.frontend', 'frontend', ['-p', 'etas_frontend', '--tests']
        yield 'P12-01.types', 'frontend', ['-p', 'etas_types', '--test', 'adt']
        yield 'P12-01.effects', 'frontend', ['-p', 'etas_effects', '--lib']
    elif phase == 'storage':
        for case in ['adt', 'checkpoint', 'memory_checkpoint', 'memory', 'memory_paging',
                     'memory_intent', 'memory_commit', 'memory_source_commit', 'storage_outcomes',
                     'session_history', 'session_publication', 'session_commit', 'message_session',
                     'conversation']:
            yield f'P12-02..06.source-embedding.{case}', 'interpreter', [
                '-p', 'etas_interpreter', '--lib', f'testing::cases::{case}::']
        for case in ['memory', 'storage', 'storage_intents', 'storage_receipts', 'storage_admission',
                     'storage_dispatch', 'storage_public_dispatch', 'session', 'session_paging',
                     'session_receipts', 'session_resolve_receipts', 'session_publication',
                     'session_retention']:
            yield f'P12-03..06.host.{case}', 'core', ['-p', 'etas_host', '--test', case]
        for prefix in ['memory::', 'storage::', 'session::']:
            yield f'P12-03..06.host-unit.{prefix}', 'core', ['-p', 'etas_host', '--lib', prefix]
    elif phase == 'lifecycle':
        yield 'P12-07.embedding', 'interpreter', [
            '-p', 'etas_interpreter', '--lib', 'testing::cases::cancellation::']
        yield 'P12-07.model-transport', 'core', ['-p', 'etas_host', '--test', 'cancellation_http']
        yield 'P12-08.cli', 'cli', ['-p', 'etas_cli', '--all-features', '--test', 'cancellation']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['source', 'storage', 'lifecycle'])
    args = parser.parse_args()
    GRAPH.guard()
    output = ROOT / 'results' / f'{args.phase}-{time.time_ns()}'
    output.mkdir(parents=True)
    results = []
    for label, workspace, selection in cases(args.phase):
        started = time.monotonic()
        command = ['cargo', 'test', '--offline', '--locked', '--manifest-path',
                   str(ROOT / workspace / 'Cargo.toml'), '--config',
                   str(ROOT / f'{workspace}-overrides.toml'), *selection, '--', '--test-threads=1']
        print('+', label, ' '.join(command), flush=True)
        try:
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=900)
            text = result.stdout + '\nSTDERR\n' + result.stderr
            counts = re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', text)
            passed, failed, ignored = (sum(int(row[i]) for row in counts) for i in range(3))
            status = 'PASS' if result.returncode == 0 and passed > 0 and failed == 0 else 'FAIL'
            code = result.returncode
        except subprocess.TimeoutExpired as error:
            text = str(error)
            passed = failed = ignored = 0
            status, code = 'TIMEOUT', None
        (output / f'{len(results):02d}.log').write_text(text)
        row = dict(case=label, layer=args.phase, status=status, exit=code, passed=passed,
                   failed=failed, ignored=ignored, seconds=round(time.monotonic() - started, 3),
                   command=command)
        results.append(row)
        (output / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(row), flush=True)
        if code == 101 and 'could not compile' in text:
            print('STOP affected suite: compilation mismatch; no assertion was executed.', flush=True)
            break
    GRAPH.guard()
    raise SystemExit(0 if all(r['status'] == 'PASS' for r in results) else 1)


if __name__ == '__main__':
    main()
