#!/usr/bin/env python3
"""SESSION-001A checks plus the unchanged affected regression chain."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent

subprocess.run(['python3', '-B', str(ROOT / 'tests/session_state_probe.py')], check=True, timeout=300)
subprocess.run(['python3', '-B', str(ROOT / 'scripts/tool-001a-verify.py')], check=True, timeout=400)
