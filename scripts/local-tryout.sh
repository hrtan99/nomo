#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $# -lt 1 ]]; then
    echo 'Usage: local-tryout.sh help | prepare NEW_DIRECTORY | new|continue|inspect-new|show DIRECTORY [native arguments]' >&2
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
    new) flow=chain_new; profile=work-chain ;;
    inspect-new) flow=chain_inspect; profile=work-chain ;;
    continue) flow=chain_continue; profile=work-chain ;;
    show) flow=chain_show; profile=work-chain-show ;;
    *) echo 'Expected help, prepare, new, continue, inspect-new or show.' >&2; exit 64 ;;
esac

compose=(docker compose --env-file /dev/null --file "$project_root/compose.yaml"
    --file "$project_root/config/etas-runtime-cache-compose.yaml"
    --file "$project_root/config/local-tryout-compose.yaml")
native=(etas run /workspace --flow "$flow" --profile "$profile" --allow-effects)
run=(run --rm --no-deps)
if [[ "$action" != help ]]; then
    [[ $# -ge 1 ]] || { echo 'An explicitly prepared fixed tryout directory is required.' >&2; exit 64; }
    tryout_root="$(python3 "$project_root/scripts/prepare-local-tryout.py" --check -- "$1")"
    shift
    export NOMO_EDIT_STATE_DIR="$tryout_root/state"
    export NOMO_EDIT_WORKSPACE_DIR="$tryout_root/workspace"
    export NOMO_WORK_CONTEXT_DIR="$tryout_root/context"
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
if [[ "$action" == new || "$action" == continue || "$action" == inspect-new ]]; then
    compose+=(--file "$project_root/config/local-tryout-model-compose.yaml")
else
    compose+=(--file "$project_root/config/local-tryout-readonly-compose.yaml")
    # Do not carry native endpoint overrides or any Provider key into help/show.
    for variable in $(compgen -e); do
        case "$variable" in ETAS_HOST_MODEL*|ETAS_HOST_OMLX*|NOMO_QWEN_SERVER_API_KEY|NOMO_GATEWAY_CLIENT_TOKEN) unset "$variable" ;; esac
    done
    run+=(--tty=false)
fi
# Transport only: all application parsing, claims, budgets and confirmations stay in Etas.
exec "${compose[@]}" "${run[@]}" dev "${native[@]}" --args "$@"
