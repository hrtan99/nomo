#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas003"
readonly model_project="${fixture_root}/model_project"
readonly case_root="$(mktemp -d /tmp/nomo-etas003.XXXXXX)"
readonly secret_value="ETAS003_TEST_TOKEN_DO_NOT_PRINT"
mock_pid=""
case_count=0

cleanup() {
    if [[ -n "${mock_pid}" ]]; then
        kill "${mock_pid}" 2>/dev/null || true
        wait "${mock_pid}" 2>/dev/null || true
    fi
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

python3 "${fixture_root}/mock_omlx.py" --port 18848 \
    >"${case_root}/mock.stdout" 2>"${case_root}/mock.stderr" &
mock_pid=$!

for _attempt in {1..50}; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:18848/health \
        >/dev/null; then
        break
    fi
    sleep 0.1
done
curl --silent --fail --max-time 1 http://127.0.0.1:18848/health \
    >/dev/null

export ETAS003_TEST_API_KEY="${secret_value}"
unset ETAS003_MISSING_API_KEY || true

assert_stream() {
    local stream_path="$1"
    local expectation="$2"
    local stream_name="$3"

    case "${expectation}" in
        EMPTY)
            if [[ -s "${stream_path}" ]]; then
                echo "expected empty ${stream_name}" >&2
                return 1
            fi
            ;;
        ANY)
            ;;
        *)
            if ! grep -Fq -- "${expectation}" "${stream_path}"; then
                echo "expected ${stream_name} to contain: ${expectation}" >&2
                return 1
            fi
            ;;
    esac
}

print_stream() {
    local stream_path="$1"
    local stream_name="$2"

    if [[ -s "${stream_path}" ]]; then
        sed "s/^/${stream_name}: /" "${stream_path}"
    else
        echo "${stream_name}: <empty>"
    fi
}

expect_case() {
    local case_name="$1"
    local expected_exit="$2"
    local expected_stdout="$3"
    local expected_stderr="$4"
    shift 4

    local stdout_path="${case_root}/${case_name}.stdout"
    local stderr_path="${case_root}/${case_name}.stderr"
    local actual_exit

    set +e
    "$@" >"${stdout_path}" 2>"${stderr_path}"
    actual_exit=$?
    set -e

    echo "CASE ${case_name}"
    echo "COMMAND $*"
    echo "EXIT ${actual_exit}"
    print_stream "${stdout_path}" STDOUT
    print_stream "${stderr_path}" STDERR

    if [[ "${actual_exit}" -ne "${expected_exit}" ]]; then
        echo "expected exit ${expected_exit}, got ${actual_exit}" >&2
        exit 1
    fi
    assert_stream "${stdout_path}" "${expected_stdout}" stdout
    assert_stream "${stderr_path}" "${expected_stderr}" stderr
    if grep -Fq -- "${secret_value}" "${stdout_path}" "${stderr_path}"; then
        echo "runtime API key leaked in ${case_name} output" >&2
        exit 1
    fi
    echo "RESULT pass"
    echo

    case_count=$((case_count + 1))
}

expect_case project_check 0 "checked 1 file" EMPTY \
    etas check "${model_project}"
expect_case project_check_phase1 1 "checked 1 file" \
    "RuntimeRequiredInPhase1" \
    etas check --phase1 "${model_project}"
expect_case profile_fingerprint 0 '"profile": "mock-success"' EMPTY \
    etas run "${model_project}" --profile mock-success --allow-effects \
    --print-runtime-profile
expect_case model_success 0 '"value":"0"' EMPTY \
    etas run "${model_project}" --profile mock-success --allow-effects \
    --budget-tokens 64
expect_case authentication_failure 3 "run value: null" \
    "OpenAI-compatible endpoint returned an error status" \
    etas run "${model_project}" --profile mock-unauthorized --allow-effects \
    --budget-tokens 64
expect_case unavailable_model 3 "run value: null" \
    "OpenAI-compatible endpoint returned an error status" \
    etas run "${model_project}" --profile mock-unavailable --allow-effects \
    --budget-tokens 64
expect_case malformed_response 3 "run value: null" \
    "OpenAI-compatible response is not valid JSON" \
    etas run "${model_project}" --profile mock-malformed --allow-effects \
    --budget-tokens 64

timeout_started_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
expect_case model_timeout 3 "run value: null" \
    "HTTP transport request deadline exceeded" \
    etas run "${model_project}" --profile mock-timeout --allow-effects \
    --budget-tokens 64
timeout_finished_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
timeout_elapsed_ms=$(((timeout_finished_ns - timeout_started_ns) / 1000000))
if ((timeout_elapsed_ms < 400 || timeout_elapsed_ms > 1500)); then
    echo "expected explicit 500ms model deadline; got ${timeout_elapsed_ms}ms" >&2
    exit 1
fi
echo "TIMEOUT elapsed_ms=${timeout_elapsed_ms} configured_ms=500"
echo

expect_case connection_failure 3 "run value: null" "HTTP request failed" \
    etas run "${model_project}" --profile mock-connection-failure \
    --allow-effects --budget-tokens 64

if grep -Fq -- "${secret_value}" "${case_root}/mock.stdout" \
    "${case_root}/mock.stderr"; then
    echo "runtime API key leaked in mock-server output" >&2
    exit 1
fi

echo "ETAS-003 deterministic matrix passed: ${case_count} cases"
