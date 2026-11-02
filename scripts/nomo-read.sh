#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage() {
    cat <<'HELP'
Usage:
  nomo-read.sh ask  --root ABSOLUTE_DIRECTORY --allow FILE[,FILE] --once QUESTION
  nomo-read.sh chat --root ABSOLUTE_DIRECTORY --allow FILE[,FILE] [--turns 4]
  nomo-read.sh session-new|session-continue --root ABSOLUTE_DIRECTORY --state PRIVATE_DIRECTORY --allow FILE[,FILE] --once QUESTION
  nomo-read.sh session-status --state PRIVATE_DIRECTORY
  nomo-read.sh edit --root ABSOLUTE_DIRECTORY --state FRESH_PRIVATE_DIRECTORY --id ID --path FILE --target TEXT --replacement TEXT [--check COMMAND ARG ...]
  nomo-read.sh edit --root ABSOLUTE_DIRECTORY --state FRESH_PRIVATE_DIRECTORY --id ID --path FILE --once TASK [--check COMMAND ARG ...]
  nomo-read.sh work --read-root ABSOLUTE_DIRECTORY --allow FILE[,FILE] --root ABSOLUTE_DIRECTORY --state FRESH_PRIVATE_DIRECTORY --id ID --path FILE --once TASK [--check COMMAND ARG ...]
  nomo-read.sh check --root ABSOLUTE_DIRECTORY -- COMMAND [ARG ...]
  nomo-read.sh edit-status --state PRIVATE_DIRECTORY --id ID --path FILE
  nomo-read.sh resume --id SESSION_ID  (not available yet)

Select one or two relative files in the read-only directory. The default model
is MiniMax M Plan (China), MiniMax-M3.1-Flash at https://api.minimax.cn/v1.
Provide its subscription key through MINIMAX_API_KEY in the environment.
MiniMax thinking counts against output limits. The runtime does not expose
the provider's finish reason under 0.2.4; review the complete edit preview carefully.
For the earlier Qwen route, explicitly set NOMO_MODEL_PROVIDER=qwen along with
NOMO_READ_MODEL_BASE_URL and NOMO_QWEN_SERVER_API_KEY; NOMO_READ_MODEL_NAME
can select a different Qwen model. These provider credentials are separate.
MiniMax defaults to verified ETAS 0.2.5; the earlier Qwen route defaults to
0.2.2. Set NOMO_ETAS_VERSION explicitly to select 0.2.2, 0.2.3, 0.2.4 or 0.2.5.
For Qwen, the endpoint is reached from the container: for a host-local forward, use
http://host.docker.internal:PORT/v1 rather than 127.0.0.1.
Chat supports two tasks by default, or four with --turns 4, in one process.
Only the immediately preceding successful task/result/answer is carried forward;
this is not a durable session. Four-turn maximum: 16 model calls and 32,768
output-token allowance; per-turn maximum: 4 calls and 8,192 output tokens.
Questions require 1..128 safe UTF-8 bytes; /help shows all bounds
and /exit ends chat. Successful completion does not verify factual accuracy.
Model editing sends the selected file and task to the configured model.
Work first reads or searches one of the allowed context files, then uses that
evidence to propose an edit to the selected workspace file. It sends context
and task to the model before write confirmation. Work is one-shot, not resume.
Its task must be 1..128 printable ASCII characters; allow one or two distinct
relative context paths of at most 48 characters each. At most one read/search
and one confirmed edit occur. The read root can be the edit workspace; state
must be separate from both. Work allows up to 7 model calls and 47,104 requested
output tokens, not a measured usage or cost limit.
For model editing, NOMO_MODEL_REQUEST_DEADLINE_MS sets each request deadline
from 2000 to 3600000 milliseconds (default 120000); there are no automatic retries.
Checks run offline and may modify the selected private workspace.
Edit status is recorded data only; it does not inspect the current file.
Use status only after the operation stops; SQLite may update state bookkeeping.
HELP
}
if [[ $# -eq 0 || ( $# -eq 1 && ( "$1" == help || "$1" == --help ) ) ]]; then usage; exit 0; fi
action="$1"; shift
if [[ "$action" == session-new || "$action" == session-continue || "$action" == session-status ]]; then
    if [[ "$action" == session-new ]]; then mode=new; elif [[ "$action" == session-continue ]]; then mode=continue; else mode=status; fi
    exec python3 "$root/scripts/nomo-read-session.py" "$mode" "$@"
fi
if [[ "$action" == resume ]]; then
    echo 'Session resume is not available yet.' >&2
    exit 1
fi
if [[ "$action" == edit-status ]]; then exec python3 "$root/scripts/nomo-edit.py" --status-only "$@"; fi
if [[ "$action" == check ]]; then exec python3 "$root/scripts/nomo-edit.py" --check-only "$@"; fi
if [[ "$action" == edit ]]; then exec python3 "$root/scripts/nomo-edit.py" "$@"; fi
if [[ "$action" == work ]]; then exec python3 "$root/scripts/nomo-edit.py" --work "$@"; fi
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
    flow=read_model_tools_chat; native=(new --allow "$allowed")
    if [[ $# -eq 2 && "$1" == --turns && "$2" == 4 ]]; then
        native+=(--turns 4)
    elif [[ $# -ne 0 ]]; then usage >&2; exit 64; fi
    if [[ -t 0 && -t 1 ]]; then tty=true; else tty=false; fi
fi
provider="${NOMO_MODEL_PROVIDER:-minimax}"
case "$provider" in
    minimax)
        if [[ -z "${MINIMAX_API_KEY:-}" ]]; then echo 'Set MINIMAX_API_KEY to a MiniMax M Plan subscription key.' >&2; exit 64; fi
        unset NOMO_QWEN_SERVER_API_KEY
        model_overlay="$root/config/nomo-minimax-read-compose.yaml"; profile=gateway-minimax-readonly ;;
    qwen)
        if [[ -z "${NOMO_READ_MODEL_BASE_URL:-}" || -z "${NOMO_QWEN_SERVER_API_KEY:-}" ]]; then
            echo 'Set NOMO_READ_MODEL_BASE_URL and NOMO_QWEN_SERVER_API_KEY before starting Qwen.' >&2; exit 64
        fi
        unset MINIMAX_API_KEY
        model_overlay="$root/config/read-chat-compose.yaml"; profile=gateway-qwen-readonly ;;
    *) echo 'NOMO_MODEL_PROVIDER must be minimax or qwen.' >&2; exit 64 ;;
esac
default_etas=0.2.2
if [[ "$provider" == minimax ]]; then default_etas=0.2.5; fi
case "${NOMO_ETAS_VERSION:-$default_etas}" in
    0.2.2) etas_overlay="$root/config/etas-022-official-compose.yaml" ;;
    0.2.3) etas_overlay="$root/config/etas-023-official-compose.yaml" ;;
    0.2.4) etas_overlay="$root/config/etas-024-official-compose.yaml" ;;
    0.2.5) etas_overlay="$root/config/etas-025-official-compose.yaml" ;;
    *) echo 'NOMO_ETAS_VERSION must be 0.2.2, 0.2.3, 0.2.4 or 0.2.5.' >&2; exit 64 ;;
esac
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
    --file "$etas_overlay"
    --file "$root/config/etas-runtime-cache-compose.yaml"
    --file "$root/config/local-tryout-compose.yaml"
    --file "$model_overlay")
run=(run --rm --no-deps --pull never --tty="$tty")
if [[ "$provider" == minimax ]]; then
    echo 'MiniMax M Plan (China): the selected context may be sent to MiniMax; thinking counts toward output limits.'
fi
exec python3 "$root/scripts/terminal-transport.py" "${compose[@]}" "${run[@]}" dev \
    python3 -B /workspace/scripts/nomo-verified-etas.py run /workspace --flow "$flow" \
    --profile "$profile" --allow-effects --args "${native[@]}"
