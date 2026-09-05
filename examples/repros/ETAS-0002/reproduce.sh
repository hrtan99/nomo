#!/usr/bin/env bash
set -euo pipefail

readonly repro_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly run_root="$(mktemp -d /tmp/etas-omlx-thinking-option.XXXXXX)"
server_pid=""

cleanup() {
    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" 2>/dev/null || true
        wait "${server_pid}" 2>/dev/null || true
    fi
    rm -rf -- "${run_root}"
}
trap cleanup EXIT

export ETAS_REPRO_CAPTURE_PATH="${run_root}/request.json"
python3 "${repro_root}/requires_option.py" \
    >"${run_root}/server.stdout" 2>"${run_root}/server.stderr" &
server_pid=$!

for _attempt in {1..50}; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:18852/health \
        >/dev/null; then
        break
    fi
    sleep 0.1
done
curl --silent --fail --max-time 1 http://127.0.0.1:18852/health >/dev/null

export ETAS_REPRO_API_KEY="ETAS_REPRO_FAKE_TOKEN"
set +e
etas run "${repro_root}" --profile requires-thinking-option --allow-effects \
    --budget-tokens 64 >"${run_root}/etas.stdout" 2>"${run_root}/etas.stderr"
status=$?
set -e

sed 's/^/STDOUT: /' "${run_root}/etas.stdout"
sed 's/^/STDERR: /' "${run_root}/etas.stderr"
echo "EXIT: ${status}"

if [[ "${status}" -ne 3 ]]; then
    echo "expected Etas exit 3" >&2
    exit 1
fi
if ! grep -Fq "OpenAI-compatible endpoint returned an error status" \
    "${run_root}/etas.stderr"; then
    echo "expected provider rejection diagnostic" >&2
    exit 1
fi
python3 - "${run_root}/request.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as request_file:
    request = json.load(request_file)
if "chat_template_kwargs" in request:
    raise SystemExit("unexpected chat_template_kwargs in Etas request")
print("REQUEST_FIELD: chat_template_kwargs absent")
PY

echo "ETAS-0002 reproduced: omlx thinking-control option cannot be expressed"
