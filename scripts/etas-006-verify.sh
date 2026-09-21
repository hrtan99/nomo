#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas006"
readonly policy_project="${fixture_root}/policy_project"
readonly cargo_patch_config="${project_root}/config/etas-003-cargo-patch.toml"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-cli-src"
readonly core_source_dir="${CARGO_HOME}/etas003-core-src"
readonly interpreter_source_dir="${CARGO_HOME}/git/checkouts/etas-interpreter-d9a8cde496090f26/5de9203"
readonly etas_revision="eb3d22b10f30fd1d5b4a376d896fec866efe964b"
readonly etas_tree="6ec029dff3d603eafbb42a062a5aee74734e329c"
readonly core_revision="9c9d3a17b007745c81e03bb49c977c9f65454b6f"
readonly core_tree="f0c50e90db91f1029cb88ccfc2cedee62ee7f157"
readonly interpreter_revision="5de9203109c75746f53e8e6bd8083fbd932f73bc"
readonly cargo_lock_sha256="3e8bfec4e09a57b52bcf4bb29f9e8c394eb91e23eadf1eb8287de9a2ff8e60d1"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas006.XXXXXX")"
case_count=0

cleanup() {
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

verify_merged_checkout() {
    local source_dir="$1"
    local revision="$2"
    local expected_tree="$3"

    if [[ "$(git -C "${source_dir}" rev-parse HEAD)" != "${revision}" ]] \
        || [[ "$(git -C "${source_dir}" rev-parse HEAD^{tree})" != "${expected_tree}" ]]; then
        echo "unexpected merged checkout identity: ${source_dir}" >&2
        exit 1
    fi
    if ! git -C "${source_dir}" diff --cached --quiet HEAD --; then
        echo "locked checkout index is not clean: ${source_dir}" >&2
        exit 1
    fi
    if ! git -C "${source_dir}" diff --quiet HEAD --; then
        echo "merged checkout worktree is not clean: ${source_dir}" >&2
        exit 1
    fi
}

expect_run() {
    local name="$1"
    local expected_exit="$2"
    local profile="$3"
    local stdout_pattern="$4"
    local stderr_pattern="$5"
    local stdin_mode="${6:-inherit}"
    local stdout_path="${case_root}/${name}.stdout"
    local stderr_path="${case_root}/${name}.stderr"
    local actual_exit

    set +e
    if [[ "${stdin_mode}" == "closed" ]]; then
        etas run "${policy_project}" --profile "${profile}" --allow-effects \
            </dev/null >"${stdout_path}" 2>"${stderr_path}"
    else
        etas run "${policy_project}" --profile "${profile}" --allow-effects \
            >"${stdout_path}" 2>"${stderr_path}"
    fi
    actual_exit=$?
    set -e

    if [[ "${actual_exit}" -ne "${expected_exit}" ]]; then
        echo "${name}: expected exit ${expected_exit}, got ${actual_exit}" >&2
        sed 's/^/STDOUT: /' "${stdout_path}" >&2
        sed 's/^/STDERR: /' "${stderr_path}" >&2
        exit 1
    fi
    if [[ -n "${stdout_pattern}" ]] && ! grep -Fq -- "${stdout_pattern}" "${stdout_path}"; then
        echo "${name}: expected stdout pattern not found" >&2
        exit 1
    fi
    if [[ -z "${stdout_pattern}" && -s "${stdout_path}" ]]; then
        echo "${name}: expected empty stdout" >&2
        exit 1
    fi
    if [[ -n "${stderr_pattern}" ]] && ! grep -Fq -- "${stderr_pattern}" "${stderr_path}"; then
        echo "${name}: expected stderr pattern not found" >&2
        sed 's/^/STDERR: /' "${stderr_path}" >&2
        exit 1
    fi
    if [[ -z "${stderr_pattern}" && -s "${stderr_path}" ]]; then
        echo "${name}: expected empty stderr" >&2
        exit 1
    fi

    printf 'CASE %s\nEXIT %s\nRESULT pass\n\n' "${name}" "${actual_exit}"
    case_count=$((case_count + 1))
}

verify_merged_checkout "${core_source_dir}" "${core_revision}" "${core_tree}"
verify_merged_checkout "${etas_source_dir}" "${etas_revision}" "${etas_tree}"
if [[ "$(git -C "${interpreter_source_dir}" rev-parse HEAD)" != "${interpreter_revision}" ]]; then
    echo "interpreter checkout is not at the CLI-locked revision" >&2
    exit 1
fi
if ! git -C "${interpreter_source_dir}" diff --quiet HEAD -- \
    || ! git -C "${interpreter_source_dir}" diff --cached --quiet HEAD --; then
    echo "interpreter checkout has tracked source drift" >&2
    exit 1
fi
printf '%s  %s\n' "${cargo_lock_sha256}" "${etas_source_dir}/Cargo.lock" \
    | sha256sum --check --status

etas check "${policy_project}"
printf 'CASE cli_policy_surface\nEXIT 0\nRESULT pass\n\n'
case_count=$((case_count + 1))

etas run "${policy_project}" --profile approval-auto --allow-effects \
    --print-runtime-profile >"${case_root}/runtime-profile.json"
python3 - "${case_root}/runtime-profile.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as profile_file:
    profile = json.load(profile_file)
assert profile["policy"] == "LocalStatic"
assert profile["approval"] == "Auto"
assert profile["filesystem"] == "None"
assert profile["command_programs"] == []
assert profile["program_network_endpoints"] == []
print("CASE cli_authority_profile")
print("EXIT 0")
print("RESULT pass")
print(f"FINGERPRINT {profile['profile_fingerprint']}\n")
PY
case_count=$((case_count + 1))

expect_run allow 0 allow ETAS006_TRACE_SECRET ""
expect_run unmatched_deny 3 unmatched-deny "" \
    "console policy denied request: local static policy has no allow rule"
expect_run approval_auto 0 approval-auto ETAS006_TRACE_SECRET ""
expect_run approval_deny 3 approval-deny "" "console policy approval was denied"
expect_run approval_prompt_non_tty 3 approval-prompt "" \
    "console policy approval was denied" closed
expect_run unknown_policy_provider 3 unknown-policy "" \
    "CLI policy provider denies unknown policy references"

set +e
etas run "${policy_project}" --profile invalid-approval --allow-effects \
    >"${case_root}/invalid.stdout" 2>"${case_root}/invalid.stderr"
invalid_exit=$?
set -e
if [[ "${invalid_exit}" -eq 0 ]] \
    || ! grep -Fq -- 'unsupported ETAS_HOST_APPROVAL mode `invalid`' \
        "${case_root}/invalid.stderr"; then
    echo "CLI did not reject invalid approval mode" >&2
    exit 1
fi
printf 'CASE invalid_approval_mode\nEXIT %s\nRESULT pass\n\n' "${invalid_exit}"
case_count=$((case_count + 1))

etas run "${policy_project}" --profile approval-auto --allow-effects \
    --trace-out "${case_root}/trace.json" >"${case_root}/trace.stdout"
python3 - "${case_root}/trace.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as trace_file:
    text = trace_file.read()
assert "ETAS006_TRACE_SECRET" not in text
trace = json.loads(text)
assert trace["schema"] == "etas.cli.interpreter-report.v1"
events = trace["events"]
started = [event for event in events if event["kind"] == "host_request_started"]
assert {event["qualified_action"] for event in started} >= {
    "Policy.evaluate",
    "Approval.request",
    "Console.stdout_write",
}
for event in events:
    for field in event.get("payload", []):
        if field["sensitivity"] in {"sensitive", "secret"}:
            assert field["value"] is None
print("CASE cli_trace_redaction")
print("EXIT 0")
print("RESULT pass")
print(f"ARTIFACT trace_bytes={len(text.encode('utf-8'))}\n")
PY
case_count=$((case_count + 1))

cp -R "${fixture_root}/host_probe" "${case_root}/host_probe"
cargo run --quiet --offline \
    --manifest-path "${case_root}/host_probe/Cargo.toml" \
    --target-dir "${case_root}/host-target"

cp -R "${interpreter_source_dir}" "${case_root}/interpreter"
cp "${etas_source_dir}/Cargo.lock" "${case_root}/interpreter/Cargo.lock"
for filter in \
    policy_approval \
    approval_validation_rejects_replayed_grant_id \
    resume_checkpoint_revalidates_approval_under_current_authority \
    run_checked_stops_host_tool_call_when_policy_approval_is_denied
do
    cargo test --quiet --offline \
        --config "${cargo_patch_config}" \
        --manifest-path "${case_root}/interpreter/Cargo.toml" \
        --target-dir "${case_root}/interpreter-target" \
        "${filter}" | tee "${case_root}/interpreter-test.log"
    grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "${case_root}/interpreter-test.log"
    printf 'CASE interpreter_%s\nEXIT 0\nRESULT pass\n\n' "${filter}"
    case_count=$((case_count + 1))
done

python3 - "${case_root}/interpreter/Cargo.lock" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as lock_file:
    packages = tomllib.load(lock_file)["package"]
by_name = {package["name"]: package for package in packages}
assert by_name["etas_host"].get("source") is None
assert by_name["etas_core"].get("source") is None
assert by_name["etas_frontend"]["source"].endswith(
    "#f24b44550c655099c9773ab22ba231cfd8ee1fcc"
)
print("CASE interpreter_dependency_identity")
print("EXIT 0")
print("RESULT pass\n")
PY
case_count=$((case_count + 1))

fixture_bytes="$(du -sb "${fixture_root}" | cut -f 1)"
printf 'ARTIFACT fixture_bytes=%s\n' "${fixture_bytes}"
printf 'ETAS-006 verification passed: %s scripted cases plus 9 host-probe cases\n' "${case_count}"
