#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose=(docker compose --env-file /dev/null --file "${project_root}/compose.yaml" --file "${project_root}/config/etas-024-official-compose.yaml")
if [[ $# -ne 1 ]]; then
    echo 'Usage: etas-024-official-container.sh {prepare|build|register-existing|verify}' >&2
    exit 64
fi
case "$1" in
    prepare)
        exec "${compose[@]}" --profile networked run --rm --no-deps --tty=false dependency \
            python3 -B /workspace/scripts/etas-024-official-cli-bootstrap.py prepare
        ;;
    build|verify)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev \
            python3 -B /workspace/scripts/etas-024-official-cli-bootstrap.py "$1"
        ;;
    register-existing)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev \
            python3 -B /workspace/scripts/etas-024-official-cli-bootstrap.py register-existing \
            --binary /home/nomo/.cargo/etas-latest/target/release/etas
        ;;
    *)
        echo 'Usage: etas-024-official-container.sh {prepare|build|register-existing|verify}' >&2
        exit 64
        ;;
esac
