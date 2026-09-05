#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

exec "${project_root}/scripts/etas-003-cli-bootstrap.sh" "$@"
