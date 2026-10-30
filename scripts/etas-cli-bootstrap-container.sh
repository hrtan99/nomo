#!/usr/bin/env bash
set -euo pipefail
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose=(docker compose --env-file /dev/null --file "${project_root}/compose.yaml" --file "${project_root}/config/etas-latest-bootstrap-compose.yaml")
if [[ $# -eq 0 ]]; then
    mode=build
elif [[ $# -eq 2 && "$1" == --adopt-binary && "$2" == /* && -f "$2" && ! -L "$2" ]]; then
    mode=adopt
    binary="$2"
else
    echo 'Usage: etas-cli-bootstrap-container.sh [--adopt-binary ABSOLUTE_VERIFIED_BINARY]' >&2
    exit 64
fi
"${compose[@]}" --profile networked run --rm --no-deps --tty=false dependency \
    /workspace/scripts/etas-cli-bootstrap.sh prepare
if [[ "$mode" == adopt ]]; then
    exec "${compose[@]}" run --rm --no-deps --tty=false \
        --volume "${binary}:/verified-etas:ro" dev \
        /workspace/scripts/etas-cli-bootstrap.sh adopt --binary /verified-etas
fi
exec "${compose[@]}" run --rm --no-deps --tty=false dev \
    /workspace/scripts/etas-cli-bootstrap.sh build
