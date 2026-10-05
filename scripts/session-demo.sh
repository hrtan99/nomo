#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $# -lt 2 ]]; then
    echo 'Usage: session-demo.sh init|save|continue|show EXISTING_DEMO_DIRECTORY [session arguments]' >&2
    exit 64
fi
readonly action="$1"
case "$action" in
    init) profile=session-demo-create ;;
    save|continue|show) profile=session-demo-existing ;;
    *) echo 'Expected init, save, continue or show.' >&2; exit 64 ;;
esac
if [[ ! -d "$2" || -L "$2" ]]; then
    echo 'An explicitly created, non-symlink demo directory is required.' >&2
    exit 64
fi
readonly demo_directory="$(cd -- "$2" && pwd -P)"
shift 2
# This launcher only wires the admitted directory and explicit runtime profile.
# All identity, claim, initialization and persistence decisions remain in Etas.
export NOMO_SESSION_DEMO_DIR="$demo_directory"
exec docker compose \
    --file "${project_root}/compose.yaml" \
    --file "${project_root}/config/etas-runtime-cache-compose.yaml" \
    --file "${project_root}/config/session-demo-compose.yaml" \
    run --rm --no-deps --tty=false dev \
    etas run /workspace --flow session --profile "$profile" --allow-effects \
    --args "$action" "$@"
