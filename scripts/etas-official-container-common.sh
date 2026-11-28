#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
label="${1:-}"
case "$label" in
    02413) target=etas-0230 ;;
    *) echo 'This checkout supports the selected Etas 0.24.13 toolchain.' >&2; exit 64 ;;
esac
shift
usage() { echo "Usage: etas-${label}-official-container.sh {prepare|build|register-existing|verify}" >&2; }
if [[ $# -ne 1 ]]; then usage; exit 64; fi
compose=(docker compose --env-file /dev/null --file "${project_root}/compose.yaml" --file "${project_root}/config/etas-${label}-official-compose.yaml")
bootstrap="/workspace/scripts/etas-${label}-official-cli-bootstrap.py"
binary_profile=release
case "$1" in
    prepare)
        exec "${compose[@]}" --profile networked run --rm --no-deps --tty=false dependency \
            python3 -B "$bootstrap" prepare ;;
    build)
        build_resources="${project_root}/config/etas-${label}-build-compose.yaml"
        if [[ -f "$build_resources" ]]; then compose+=(--file "$build_resources"); fi
        exec "${compose[@]}" run --rm --no-deps --tty=false dev python3 -B "$bootstrap" build ;;
    verify)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev python3 -B "$bootstrap" "$1" ;;
    register-existing)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev \
            python3 -B "$bootstrap" register-existing --binary "/home/nomo/.cargo/${target}/target/${binary_profile}/etas" ;;
    *) usage; exit 64 ;;
esac
