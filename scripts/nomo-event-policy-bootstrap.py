#!/usr/bin/env python3
"""Place the private policy on container tmpfs, then exec the verified CLI."""
import importlib.util
import os
from pathlib import Path
import sys

data = sys.stdin.buffer.read(4097)
if not 1 <= len(data) <= 4096:
    raise SystemExit('invalid private event policy transfer')
spec = importlib.util.spec_from_file_location('nomo_event_policy', Path(__file__).resolve().parent / 'nomo-event-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
policy.write_tmp('/tmp/nomo-event-policy', data)
os.execv(sys.executable, [sys.executable, '-B', '/workspace/scripts/nomo-verified-etas.py', *sys.argv[1:]])
