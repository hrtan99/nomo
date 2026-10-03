#!/usr/bin/env bash
set -euo pipefail
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
python3 -B "${project_root}/tests/normal_graph_identity.py"
etas check "${project_root}"
etas check --all "${project_root}"
etas effects "${project_root}"
timeout 180 python3 -B "${project_root}/tests/foundation_probe.py"
python3 -B "${project_root}/scripts/count-sloc.py"
