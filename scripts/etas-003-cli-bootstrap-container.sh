#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

exec docker compose \
    --file "${project_root}/compose.yaml" \
    --profile networked \
    run \
    --rm \
    --no-deps \
    --tty=false \
    --volume "${project_root}:/workspace:ro" \
    dependency \
    /workspace/scripts/etas-003-cli-bootstrap.sh
