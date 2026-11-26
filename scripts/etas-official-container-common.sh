#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
label="${1:-}"
case "$label" in
    012|022|023|024) target=etas-latest ;;
    025|026|030) target="etas-${label}" ;;
    0224|0227|0230) target="etas-${label}" ;;
    041|0120|0121|0130|0131|0132|0133|0134|0135) target=etas-latest ;;
    *) echo 'Unsupported official Etas version.' >&2; exit 64 ;;
esac
shift
usage() { echo "Usage: etas-${label}-official-container.sh {prepare|build|register-existing|verify}" >&2; }
if [[ $# -ne 1 ]]; then usage; exit 64; fi
compose=(docker compose --env-file /dev/null --file "${project_root}/compose.yaml" --file "${project_root}/config/etas-${label}-official-compose.yaml")
bootstrap="/workspace/scripts/etas-${label}-official-cli-bootstrap.py"
binary_profile=release
if [[ "$label" == 0224 || "$label" == 0227 || "$label" == 0230 ]]; then binary_profile=debug; fi
if [[ "$label" == 0135 ]]; then bootstrap="/workspace/scripts/etas-latest-cli-bootstrap.py"; fi
case "$1" in
    prepare)
        exec "${compose[@]}" --profile networked run --rm --no-deps --tty=false dependency \
            python3 -B "$bootstrap" prepare ;;
    build|verify)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev python3 -B "$bootstrap" "$1" ;;
    register-existing)
        exec "${compose[@]}" run --rm --no-deps --tty=false dev \
            python3 -B "$bootstrap" register-existing --binary "/home/nomo/.cargo/${target}/target/${binary_profile}/etas" ;;
    *) usage; exit 64 ;;
esac
