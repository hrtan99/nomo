#!/usr/bin/env bash
set -euo pipefail
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bash "${project_root}/scripts/foundation-002-verify.sh"
timeout 180 python3 -B "${project_root}/tests/model_probe.py"
