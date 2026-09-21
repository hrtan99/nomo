#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas005"
readonly surface_project="${fixture_root}/command_project"
readonly core_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-core-src"
readonly command_source="${core_source_dir}/crates/etas_host/src/command/local.rs"
readonly core_revision="9c9d3a17b007745c81e03bb49c977c9f65454b6f"
readonly core_tree="f0c50e90db91f1029cb88ccfc2cedee62ee7f157"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas005.XXXXXX")"

cleanup() {
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

if [[ "$(git -C "${core_source_dir}" rev-parse HEAD)" != "${core_revision}" ]] \
    || [[ "$(git -C "${core_source_dir}" rev-parse HEAD^{tree})" != "${core_tree}" ]]; then
    echo "etas-core checkout is not at the merged locked revision" >&2
    exit 1
fi
if ! git -C "${core_source_dir}" diff --cached --quiet HEAD --; then
    echo "etas-core index is not clean" >&2
    exit 1
fi
if ! git -C "${core_source_dir}" diff --quiet HEAD --; then
    echo "etas-core worktree is not clean" >&2
    exit 1
fi

etas check "${surface_project}"
set +e
etas check --phase1 "${surface_project}" \
    >"${case_root}/phase1.stdout" 2>"${case_root}/phase1.stderr"
phase1_exit=$?
set -e
if [[ "${phase1_exit}" -ne 1 ]] \
    || ! grep -Fq -- 'RuntimeRequiredInPhase1' "${case_root}/phase1.stderr"; then
    echo "expected the command surface to require a Phase 1 host" >&2
    exit 1
fi
printf 'CASE cli_phase1_command_requirement\nEXIT %s\nRESULT pass\n\n' "${phase1_exit}"

etas run "${surface_project}" --profile command --allow-effects \
    --print-runtime-profile >"${case_root}/runtime-profile.json"
python3 - "${case_root}/runtime-profile.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as profile_file:
    profile = json.load(profile_file)
assert profile["command_programs"] == ["/bin/sh", "/usr/bin/python3"]
assert profile["policy"] == "LocalStatic"
assert profile["filesystem"] == "None"
assert profile["program_network_endpoints"] == []
print("CASE cli_command_profile")
print("RESULT pass")
print(f"DETAIL command_programs={profile['command_programs']} policy={profile['policy']}")
print(f"FINGERPRINT {profile['profile_fingerprint']}\n")
PY

set +e
cp "${fixture_root}/constructor_gap.es" "${case_root}/constructor_gap.es"
etas check "${case_root}/constructor_gap.es" \
    >"${case_root}/constructor-gap.stdout" 2>"${case_root}/constructor-gap.stderr"
constructor_exit=$?
set -e
if [[ "${constructor_exit}" -ne 1 ]] || ! grep -Fq -- 'error[' "${case_root}/constructor-gap.stderr"; then
    echo "expected source-level Command construction to fail with a checker diagnostic" >&2
    exit 1
fi
printf 'CASE cli_command_constructor\nEXIT %s\n' "${constructor_exit}"
sed 's/^/STDERR: /' "${case_root}/constructor-gap.stderr"
printf 'RESULT pass (invalid record remains rejected)\n\n'

set +e
etas run "${surface_project}" --flow run_command --profile command --allow-effects \
    --args /bin/sh \
    >"${case_root}/entry.stdout" 2>"${case_root}/entry.stderr"
entry_exit=$?
set -e
if [[ "${entry_exit}" -ne 1 ]] \
    || ! grep -Fq -- 'must resolve to `flow run_command(args: Array[string]) -> i32`' \
        "${case_root}/entry.stderr"; then
    echo "expected CLI to reject a Command-typed entry flow" >&2
    exit 1
fi
printf 'CASE cli_command_entry_input\nEXIT %s\n' "${entry_exit}"
sed 's/^/STDERR: /' "${case_root}/entry.stderr"
printf 'RESULT pass (unsupported CLI entry remains rejected)\n\n'

grep -Fq -- 'request.budget.check_time()?' "${command_source}"
grep -Fq -- 'SupervisedCommand::spawn' "${command_source}"
printf '%s\n' \
    'CASE locked_command_lifecycle_source' \
    'RESULT pass' \
    'DETAIL merged supervisor selected; behavior checked by Host probe' \
    ''

cp -R "${fixture_root}/host_probe" "${case_root}/host_probe"
NOMO_GATEWAY_CLIENT_TOKEN="ETAS005_PUBLIC_SENTINEL" cargo run --quiet --offline \
    --manifest-path "${case_root}/host_probe/Cargo.toml" \
    --target-dir "${case_root}/target"

fixture_bytes="$(du -sb "${fixture_root}" | cut -f 1)"
printf 'ARTIFACT fixture_bytes=%s\n' "${fixture_bytes}"
echo "ETAS-005 verification completed: CLI surface plus host command matrix"
