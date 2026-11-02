#!/usr/bin/env python3
"""Run the existing legacy controller vectors against this exact 0.2.3 candidate.

Only the selected CLI identity and changed controller source hash are rebound;
all original vectors, expected transcripts, effects and negative checks remain.
"""
import hashlib
from pathlib import Path
import sys
import shared_chat_controller_probe as suite

CLI = Path('/home/nomo/.cargo/bin/etas')
CLI_SHA = '82069afbdd100254dfc2f80dfcf049f6f5e46a3b7e533b56c546821db4cbdaab'
CONTROLLER_SHA = '911f9c6c056952730e5fd4028eea57d6e842973e6c80ecaf00d9a3b0ec6d8bad'

if __name__ == '__main__':
    assert CLI.is_file() and not CLI.is_symlink()
    assert hashlib.sha256(CLI.read_bytes()).hexdigest() == CLI_SHA
    suite.PRODUCT_HASHES['src/nomo/harness/shared_chat_controller.es'] = CONTROLLER_SHA
    suite.verify_cli = lambda: CLI
    suite.main()
