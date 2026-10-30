#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $# -lt 1 ]]; then
    echo 'Usage: local-tryout.sh help|terminal-help | prepare NEW_DIRECTORY | new|user-context-new|continue|inspect-new|observe-new|observe-continue|terminal|show|sessions DIRECTORY [native arguments]' >&2
    exit 64
fi
readonly action="$1"
shift
case "$action" in
    prepare)
        [[ $# -eq 1 ]] || { echo 'prepare requires exactly one new directory.' >&2; exit 64; }
        exec python3 "$project_root/scripts/prepare-local-tryout.py" -- "$1"
        ;;
    help) flow=chain_help; profile=chain-help ;;
    terminal-help) flow=terminal_help; profile=chain-help ;;
    terminal)
        if [[ -t 0 && -t 1 ]]; then
            flow=terminal; profile=work-chain; terminal_tty=true; terminal_approval=prompt
        else
            flow=terminal_once; profile=work-chain-once; terminal_tty=false; terminal_approval=deny
        fi
        ;;
    new) flow=chain_new; profile=work-chain ;;
    user-context-new)
        flow=chain_user_context_new
        if [[ -t 0 && -t 1 ]]; then profile=work-chain; user_input_mode=tty; terminal_tty=true; terminal_approval=prompt
        else profile=work-chain-once; user_input_mode=non-tty; terminal_tty=false; terminal_approval=deny; fi
        ;;
    inspect-new) flow=chain_inspect; profile=work-chain ;;
    observe-new) flow=chain_observe_new; profile=work-chain ;;
    observe-continue) flow=chain_observe_continue; profile=work-chain ;;
    continue) flow=chain_continue; profile=work-chain ;;
    show) flow=chain_show; profile=work-chain-show ;;
    sessions) flow=chain_sessions; profile=work-chain-show ;;
    *) echo 'Expected help, terminal-help, prepare, new, user-context-new, continue, inspect-new, observe-new, observe-continue, terminal, show or sessions.' >&2; exit 64 ;;
esac

compose=(docker compose --env-file /dev/null --file "$project_root/compose.yaml"
    --file "$project_root/config/etas-runtime-cache-compose.yaml"
    --file "$project_root/config/local-tryout-compose.yaml")
native=(etas run /workspace --flow "$flow" --profile "$profile" --allow-effects)
run=(run --rm --no-deps)
if [[ "$action" == terminal || "$action" == user-context-new ]]; then
    run+=(--tty="$terminal_tty" -e "ETAS_HOST_APPROVAL=$terminal_approval")
fi
if [[ "$action" != help && "$action" != terminal-help ]]; then
    [[ $# -ge 1 ]] || { echo 'An explicitly prepared fixed tryout directory is required.' >&2; exit 64; }
    tryout_root="$(python3 "$project_root/scripts/prepare-local-tryout.py" --check -- "$1")"
    shift
    export NOMO_EDIT_STATE_DIR="$tryout_root/state"
    export NOMO_EDIT_WORKSPACE_DIR="$tryout_root/workspace"
    export NOMO_WORK_CONTEXT_DIR="$tryout_root/context"
    if [[ "$action" == user-context-new ]]; then
        [[ $# -ge 2 && "$1" == --read-root ]] || { echo 'user-context-new requires --read-root ABSOLUTE_DIRECTORY before work options.' >&2; exit 64; }
        selected_root="$2"
        while [[ "$selected_root" != / && "$selected_root" == */ ]]; do selected_root="${selected_root%/}"; done
        [[ "$selected_root" == /* && "$selected_root" != */. && "$selected_root" != */.. && -d "$selected_root" && ! -L "$selected_root" ]] || { echo 'read root must be an existing absolute directory with a non-symlink leaf.' >&2; exit 64; }
        # Compare resolved paths before mounting; this is not a race-free file snapshot.
        if ! python3 - "$selected_root" "$NOMO_EDIT_WORKSPACE_DIR" "$NOMO_EDIT_STATE_DIR" <<'PY_PATHS'
import os, sys
from pathlib import Path
try:
    read_root, *writable = (str(Path(value).resolve(strict=True)) for value in sys.argv[1:])
    if any(os.path.commonpath((read_root, target)) in (read_root, target) for target in writable):
        raise ValueError("overlap")
except (OSError, RuntimeError, ValueError):
    print("read root must not overlap writable tryout workspace or state", file=sys.stderr)
    sys.exit(1)
PY_PATHS
        then exit 64; fi
        shift 2
        export NOMO_WORK_CONTEXT_DIR="$selected_root"
        set -- --read-root "$selected_root" --input-mode "$user_input_mode" "$@"
    fi
    compose+=(--file "$project_root/config/edit-operation-compose.yaml" --file "$project_root/config/harness-work-compose.yaml")
    if [[ -n "${NOMO_TRYOUT_TRACE_NAME:-}" ]]; then
        trace_name="$NOMO_TRYOUT_TRACE_NAME"
        if [[ ${#trace_name} -gt 64 || "$trace_name" != trace-*.json || "$trace_name" == *[!A-Za-z0-9._-]* ]]; then
            echo 'NOMO_TRYOUT_TRACE_NAME requires a trace-*.json basename of at most64 ASCII characters.' >&2; exit 64
        fi
        if [[ -e "$tryout_root/state/$trace_name" || -L "$tryout_root/state/$trace_name" ]]; then
            echo 'Trace destination already exists; it was preserved.' >&2; exit 64
        fi
        native+=(--trace-out "/state/$trace_name")
    fi
fi
if [[ "$action" == new || "$action" == user-context-new || "$action" == continue || "$action" == inspect-new || "$action" == observe-new || "$action" == observe-continue || "$action" == terminal ]]; then
    compose+=(--file "$project_root/config/local-tryout-model-compose.yaml")
else
    compose+=(--file "$project_root/config/local-tryout-readonly-compose.yaml")
    # Do not carry native endpoint overrides or any Provider key into help/terminal-help/show.
    for variable in $(compgen -e); do
        case "$variable" in ETAS_HOST_MODEL*|ETAS_HOST_OMLX*|NOMO_QWEN_SERVER_API_KEY|NOMO_GATEWAY_CLIENT_TOKEN) unset "$variable" ;; esac
    done
    run+=(--tty=false)
    if [[ "$action" == terminal-help ]]; then run+=(-e ETAS_HOST_APPROVAL=deny); fi
fi
# Transport only: all application parsing, claims, budgets and confirmations stay in Etas.
if [[ "$action" == terminal || "$action" == user-context-new ]]; then
    exec python3 "$project_root/scripts/terminal-transport.py" "${compose[@]}" "${run[@]}" dev "${native[@]}" --args "$@"
fi
exec "${compose[@]}" "${run[@]}" dev "${native[@]}" --args "$@"
