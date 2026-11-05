#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
label="${1:-}"
case "$label" in
    012|022|023|024) target=etas-latest ;;
    025|026|030) target="etas-${label}" ;;
    041) target=etas-latest ;;
    *) echo 'Unsupported official Etas version.' >&2; exit 64 ;;
esac
shift
usage() { echo "Usage: etas-${label}-official-container.sh {prepare|build|register-existing|verify}" >&2; }
if [[ $# -ne 1 ]]; then usage; exit 64; fi
compose=(docker compose --env-file /dev/null --file "${project_root}/compose.yaml" --file "${project_root}/config/etas-${label}-official-compose.yaml")
bootstrap="/workspace/scripts/etas-${label}-official-cli-bootstrap.py"
if [[ "$label" == 041 ]]; then bootstrap="/workspace/scripts/etas-latest-cli-bootstrap.py"; fi
case "$1" in
    prepare)
        exec "${compose[@]}" --profile networked run --rm --no-deps --tty=false dependency \
            python3 -B "$bootstrap" prepare ;;
    build|verify)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev python3 -B "$bootstrap" "$1" ;;
    register-existing)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev \
            python3 -B "$bootstrap" register-existing --binary "/home/nomo/.cargo/${target}/target/release/etas" ;;
    *) usage; exit 64 ;;
esac
