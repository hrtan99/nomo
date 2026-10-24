#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

docker compose \
    --file "${project_root}/compose.yaml" \
    --file "${project_root}/config/etas-latest-bootstrap-compose.yaml" \
    --profile networked \
    run \
    --rm \
    --no-deps \
    --tty=false \
    dependency \
    /workspace/scripts/etas-cli-bootstrap.sh prepare --seed /baseline

exec docker compose \
    --file "${project_root}/compose.yaml" \
    --file "${project_root}/config/etas-latest-bootstrap-compose.yaml" \
    run --rm --no-deps --tty=false dev \
    /workspace/scripts/etas-cli-bootstrap.sh build
