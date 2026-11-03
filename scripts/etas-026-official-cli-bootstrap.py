#!/usr/bin/env python3
"""Select and verify the official ETAS 026 dependency graph."""
import importlib.util, os
from pathlib import Path

_spec = importlib.util.spec_from_file_location('nomo_official_026_common', Path(__file__).with_name('etas-official-cli-common.py'))
_common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_common)
_common.configure({None:'026', '026-20261103-a':'026', 'latest026':'026', '026-v68':'026-v68', 'latest026v68':'026-v68'}[os.environ.get('NOMO_NORMAL_GRAPH')], Path(__file__))
INSTALLED = _common.INSTALLED
ROOT = _common.ROOT
verify = _common.verify
guard = _common.guard

if __name__ == '__main__':
    _common.main()
