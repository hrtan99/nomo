#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage() {
    cat <<'HELP'
Usage:
  nomo-read.sh ask  --root ABSOLUTE_DIRECTORY --allow FILE[,FILE] --once QUESTION
  nomo-read.sh chat --root ABSOLUTE_DIRECTORY --allow FILE[,FILE]
  nomo-read.sh edit --root ABSOLUTE_DIRECTORY --state FRESH_PRIVATE_DIRECTORY --id ID --path FILE --target TEXT --replacement TEXT

Select one or two relative files in the read-only directory. Set
NOMO_READ_MODEL_BASE_URL to the reachable Qwen OpenAI-compatible endpoint and
NOMO_QWEN_SERVER_API_KEY in the environment before starting. Set
NOMO_READ_MODEL_NAME when the server uses a different model name.
The endpoint is reached from the container: for a host-local forward, use
http://host.docker.internal:PORT/v1 rather than 127.0.0.1.
Chat supports two tasks in one process; it is not a durable session.
Questions require 1..128 safe UTF-8 bytes; /help shows all bounds
and /exit ends chat. Successful completion does not verify factual accuracy.
HELP
}
if [[ $# -eq 0 || ( $# -eq 1 && ( "$1" == help || "$1" == --help ) ) ]]; then usage; exit 0; fi
action="$1"; shift
if [[ "$action" == edit ]]; then exec python3 "$root/scripts/nomo-edit.py" "$@"; fi
if [[ "$action" != ask && "$action" != chat ]]; then usage >&2; exit 64; fi
if [[ $# -lt 4 || "$1" != --root || "$3" != --allow ]]; then usage >&2; exit 64; fi
selected="$2"; allowed="$4"; shift 4
while [[ "$selected" != / && "$selected" == */ ]]; do selected="${selected%/}"; done
if [[ "$selected" != /* || "$selected" == */. || "$selected" == */.. || ! -d "$selected" || -L "$selected" ]]; then
    echo 'Select an existing absolute read directory with a non-symlink leaf.' >&2; exit 64
fi
if [[ -z "$allowed" || ${#allowed} -gt 97 ]]; then echo 'Select one or two relative files with --allow.' >&2; exit 64; fi
if [[ "$action" == ask ]]; then
    if [[ $# -ne 2 || "$1" != --once || -z "$2" ]]; then usage >&2; exit 64; fi
    flow=read_model_tools; native=(new --allow "$allowed" --once "$2"); tty=false
else
    if [[ $# -ne 0 ]]; then usage >&2; exit 64; fi
    flow=read_model_tools_chat; native=(new --allow "$allowed")
    if [[ -t 0 && -t 1 ]]; then tty=true; else tty=false; fi
fi
if [[ -z "${NOMO_READ_MODEL_BASE_URL:-}" || -z "${NOMO_QWEN_SERVER_API_KEY:-}" ]]; then
    echo 'Set NOMO_READ_MODEL_BASE_URL and NOMO_QWEN_SERVER_API_KEY before starting.' >&2; exit 64
fi
# Docker cannot create a tmpfs mountpoint inside the read-only source bind.
# Create only this disposable, empty project cache directory before mounting.
if [[ -L "$root/.etas" ]]; then echo 'Project .etas mountpoint must not be a symlink.' >&2; exit 64; fi
if [[ ! -d "$root/.etas" ]]; then
    if ! mkdir -m 700 -- "$root/.etas"; then
        echo 'Cannot create the project .etas mountpoint; create an empty directory there first.' >&2; exit 1
    fi
fi
export NOMO_READ_ROOT="$selected"
compose=(docker compose --env-file /dev/null --file "$root/compose.yaml"
    --file "$root/config/etas-022-official-compose.yaml"
    --file "$root/config/etas-runtime-cache-compose.yaml"
    --file "$root/config/local-tryout-compose.yaml"
    --file "$root/config/read-chat-compose.yaml")
run=(run --rm --no-deps --pull never --tty="$tty")
exec python3 "$root/scripts/terminal-transport.py" "${compose[@]}" "${run[@]}" dev \
    python3 -B /workspace/scripts/nomo-verified-etas.py run /workspace --flow "$flow" \
    --profile gateway-qwen-readonly --allow-effects --args "${native[@]}"
