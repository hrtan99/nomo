#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

exec docker compose \
    --file "${project_root}/compose.yaml" \
    build \
    --pull \
    dev
