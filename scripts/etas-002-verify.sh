#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas002"
readonly case_root="$(mktemp -d /tmp/nomo-etas002.XXXXXX)"
readonly isolated_root="${case_root}/single"
case_count=0

cleanup() {
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

mkdir -p "${isolated_root}"
cp "${fixture_root}/single/"*.es "${isolated_root}/"

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
    echo "RESULT pass"
    echo

    case_count=$((case_count + 1))
}

readonly console_project="${fixture_root}/console_project"
readonly nested_single="${fixture_root}/single/success.es"

expect_case project_check 0 "checked 1 file" EMPTY \
    etas check "${project_root}"
expect_case project_check_all 0 "checked 1 file" EMPTY \
    etas check --all "${project_root}"
expect_case project_check_phase1 0 "checked 1 file" EMPTY \
    etas check --phase1 "${project_root}"
expect_case project_run 0 '"value":"0"' EMPTY \
    etas run "${project_root}"

expect_case nested_single_discovers_project 1 "checked 1 file" \
    'entry module `nomo.main` was not found' \
    etas check "${nested_single}"

expect_case single_check 0 "checked 1 file" EMPTY \
    etas check "${isolated_root}/success.es"
expect_case single_check_phase1 0 "checked 1 file" EMPTY \
    etas check --phase1 "${isolated_root}/success.es"
expect_case single_run 0 '"value":"0"' EMPTY \
    etas run "${isolated_root}/success.es"

expect_case syntax_check 1 "checked 1 file" \
    "error[syntax::InvalidExpression]" \
    etas check "${isolated_root}/syntax_error.es"
expect_case syntax_run 1 EMPTY \
    "error[syntax::InvalidExpression]" \
    etas run "${isolated_root}/syntax_error.es"
expect_case runtime_failure 3 "run value: null" \
    "maximum interpreter call depth (32) exceeded" \
    etas run "${isolated_root}/runtime_failure.es" --max-call-depth 32

expect_case console_check 0 "checked 1 file" EMPTY \
    etas check "${isolated_root}/console.es"
expect_case console_check_phase1 1 "checked 1 file" \
    "RuntimeRequiredInPhase1" \
    etas check --phase1 "${isolated_root}/console.es"
expect_case console_run_default 0 "console boundary" EMPTY \
    etas run "${isolated_root}/console.es"

expect_case profile_project_check 0 "checked 1 file" EMPTY \
    etas check "${console_project}"
expect_case profile_project_check_phase1 1 "checked 1 file" \
    "RuntimeRequiredInPhase1" \
    etas check --phase1 "${console_project}"
expect_case profile_allow_fingerprint 0 \
    '"profile_fingerprint": "fnv1a64:057c43f0b22de726"' EMPTY \
    etas run "${console_project}" --profile console-allow --allow-effects \
    --print-runtime-profile
expect_case profile_deny_fingerprint 0 \
    '"profile_fingerprint": "fnv1a64:183260c9ff39649f"' EMPTY \
    etas run "${console_project}" --profile console-deny --allow-effects \
    --print-runtime-profile
expect_case profile_allow_run 0 "profile console boundary" EMPTY \
    etas run "${console_project}" --profile console-allow --allow-effects
expect_case profile_deny_run 3 EMPTY \
    "console policy denied request" \
    etas run "${console_project}" --profile console-deny --allow-effects
expect_case profile_missing 2 EMPTY \
    'runtime profile `missing` is not defined' \
    etas run "${console_project}" --profile missing

echo "ETAS-002 matrix passed: ${case_count} cases"
