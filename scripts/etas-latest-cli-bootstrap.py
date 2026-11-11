#!/usr/bin/env python3
"""Select and verify the official ETAS 0.13.1 dependency graph."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location('nomo_official_041_common', Path(__file__).with_name('etas-official-cli-common.py'))
_common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_common)
_common.configure('0131', Path(__file__))
INSTALLED, ROOT, verify, guard, main = _common.INSTALLED, _common.ROOT, _common.verify, _common.guard, _common.main

if __name__ == '__main__':
    main()
