#!/usr/bin/env python3
"""Run a followup edit using saved conversation and prior work as untrusted context."""
import importlib.util,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('nomo_work_launcher',root/'scripts/nomo-history-work.py');work=importlib.util.module_from_spec(spec);spec.loader.exec_module(work)
def main(argv=None):
    argv=list(sys.argv[1:] if argv is None else argv)
    options=argv[:argv.index('--check')] if '--check' in argv else argv
    event=any(item=='--events-policy-dir' or item.startswith('--events-policy-dir=') for item in options)
    return work.main(['--event-followup' if event else '--legacy-followup',*argv])
if __name__=='__main__':raise SystemExit(main())
