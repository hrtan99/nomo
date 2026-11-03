#!/usr/bin/env python3
"""Authenticate a mounted private policy without consuming interactive stdin."""
import hmac
import importlib.util
import os
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location('nomo_event_policy', Path(__file__).resolve().parent / 'nomo-event-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def prepare(source, target, expected):
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError('invalid policy binding')
    _, data, actual = policy.read_private(source)
    if not hmac.compare_digest(actual, expected):
        raise ValueError('event policy changed before dispatch')
    policy.write_tmp(target, data)


def main():
    if len(sys.argv) < 3:raise SystemExit('event policy binding and command required')
    try:
        prepare('/event-policy-source', '/tmp/nomo-event-policy', sys.argv[1])
    except (OSError, ValueError):
        print('REFUSED private event policy unavailable or changed before dispatch', file=sys.stderr, flush=True)
        return 1
    os.execv(sys.executable, [sys.executable, '-B', '/workspace/scripts/nomo-verified-etas.py', *sys.argv[2:]])


if __name__ == '__main__':raise SystemExit(main())
