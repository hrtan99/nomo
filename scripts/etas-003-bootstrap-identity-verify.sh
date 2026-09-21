#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-cli-src"
readonly core_source_dir="${CARGO_HOME}/etas003-core-src"
readonly case_root="$(mktemp -d /tmp/nomo-etas003-identity.XXXXXX)"
active_source_dir=""
active_test_file=""
case_count=0

cleanup_test_change() {
    if [[ -n "${active_source_dir}" && -n "${active_test_file}" ]]; then
        /usr/bin/git -C "${active_source_dir}" restore \
            --staged --worktree --source=HEAD -- "${active_test_file}" \
            2>/dev/null || true
    fi
    active_source_dir=""
    active_test_file=""
}

cleanup() {
    cleanup_test_change
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

select_clean_tracked_file() {
    local source_dir="$1"
    local candidate

    while IFS= read -r candidate; do
        if /usr/bin/git -C "${source_dir}" diff --quiet HEAD -- "${candidate}"; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done < <(/usr/bin/git -C "${source_dir}" ls-files)

    echo "no clean tracked file available for staged-drift regression" >&2
    return 1
}

expect_staged_drift_rejected() {
    local case_name="$1"
    local source_dir="$2"
    local drift_mode="${3:-index}"
    local stdout_path="${case_root}/${case_name}.stdout"
    local stderr_path="${case_root}/${case_name}.stderr"
    local actual_exit

    active_source_dir="${source_dir}"
    active_test_file="$(select_clean_tracked_file "${source_dir}")"
    printf '\nETAS003 harmless staged-drift regression marker\n' \
        >>"${source_dir}/${active_test_file}"
    if [[ "${drift_mode}" == "index" ]]; then
        /usr/bin/git -C "${source_dir}" add -- "${active_test_file}"
    fi

    set +e
    "${project_root}/scripts/etas-003-cli-bootstrap.sh" \
        >"${stdout_path}" 2>"${stderr_path}"
    actual_exit=$?
    set -e

    echo "CASE ${case_name}"
    echo "EXIT ${actual_exit}"
    sed 's/^/STDERR: /' "${stderr_path}"

    if [[ "${actual_exit}" -eq 0 ]]; then
        echo "bootstrap accepted staged source drift" >&2
        exit 1
    fi
    if ! grep -Fq -- \
        "refusing tracked ${drift_mode} drift from locked HEAD in ${source_dir}" \
        "${stderr_path}"; then
        echo "bootstrap did not report the expected staged-drift diagnostic" >&2
        exit 1
    fi

    cleanup_test_change
    echo "RESULT pass"
    echo
    case_count=$((case_count + 1))
}

for source_dir in "${core_source_dir}" "${etas_source_dir}"; do
    if [[ ! -d "${source_dir}/.git" ]]; then
        echo "required prepared checkout is missing: ${source_dir}" >&2
        exit 1
    fi
    /usr/bin/git -C "${source_dir}" diff --quiet HEAD --
    /usr/bin/git -C "${source_dir}" diff --cached --quiet HEAD --
done

expect_staged_drift_rejected core_staged_drift "${core_source_dir}"
expect_staged_drift_rejected etas_staged_drift "${etas_source_dir}"
expect_staged_drift_rejected core_unstaged_drift "${core_source_dir}" worktree
expect_staged_drift_rejected etas_unstaged_drift "${etas_source_dir}" worktree

echo "ETAS-003 bootstrap identity regression passed: ${case_count} cases"
