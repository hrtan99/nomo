#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

exec python3 -B "${project_root}/scripts/etas-0013-cli-bootstrap.py" "${@:-build}"
