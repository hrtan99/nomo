#!/usr/bin/env bash
set -euo pipefail

readonly repro_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly run_root="$(mktemp -d /tmp/etas-model-deadline.XXXXXX)"
server_pid=""

cleanup() {
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" 2>/dev/null || true
        wait "${server_pid}" 2>/dev/null || true
    fi
    rm -rf -- "${run_root}"
}
trap cleanup EXIT

python3 "${repro_root}/slow_model.py" \
    >"${run_root}/server.stdout" 2>"${run_root}/server.stderr" &
server_pid=$!

for _attempt in {1..50}; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:18851/health \
        >/dev/null; then
        break
    fi
    sleep 0.1
done
curl --silent --fail --max-time 1 http://127.0.0.1:18851/health >/dev/null

export ETAS_REPRO_API_KEY="ETAS_REPRO_FAKE_TOKEN"
started="${SECONDS}"
set +e
etas run "${repro_root}" --profile slow-model --allow-effects \
    --budget-tokens 64 >"${run_root}/etas.stdout" 2>"${run_root}/etas.stderr"
status=$?
set -e
elapsed=$((SECONDS - started))

sed 's/^/STDOUT: /' "${run_root}/etas.stdout"
sed 's/^/STDERR: /' "${run_root}/etas.stderr"
echo "EXIT: ${status}"
echo "ELAPSED_SECONDS: ${elapsed}"

if [[ "${status}" -ne 3 ]]; then
    echo "expected Etas exit 3" >&2
    exit 1
fi
if ! grep -Fq "HTTP request failed" "${run_root}/etas.stderr"; then
    echo "expected the fixed transport timeout diagnostic" >&2
    exit 1
fi
if ((elapsed < 4 || elapsed > 7)); then
    echo "expected failure near the fixed 4.5-second deadline" >&2
    exit 1
fi

echo "ETAS-0001 reproduced: model deadline is fixed and not configurable"
