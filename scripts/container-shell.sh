#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
service="dev"

if [[ "${1:-}" == "--networked" ]]; then
    service="dependency"
    shift
fi

if (( $# == 0 )); then
    set -- /bin/bash -l
fi

if [[ "${service}" == "dependency" ]]; then
    exec docker compose \
        --file "${project_root}/compose.yaml" \
        --profile networked \
        run \
        --rm \
        --no-deps \
        dependency \
        "$@"
fi

exec docker compose \
    --file "${project_root}/compose.yaml" \
    run \
    --rm \
    --no-deps \
    dev \
    "$@"
