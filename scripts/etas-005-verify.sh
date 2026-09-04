#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas005"
readonly surface_project="${fixture_root}/command_project"
readonly core_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-core-src"
readonly command_source="${core_source_dir}/crates/etas_host/src/command/local.rs"
readonly core_base_revision="a1636207a8c5c2aadbebf11543871ab058d86e00"
readonly core_diff_sha256="f6645ad702a04f11d571ab18fa5d81b34093fedd858d788f5eb5bcd93ad089a2"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas005.XXXXXX")"

cleanup() {
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

if [[ "$(git -C "${core_source_dir}" rev-parse HEAD)" != "${core_base_revision}" ]]; then
    echo "etas-core checkout is not at the ETAS-003 locked base" >&2
    exit 1
fi
if ! git -C "${core_source_dir}" diff --cached --quiet HEAD --; then
    echo "etas-core index is not clean" >&2
    exit 1
fi
actual_core_diff="$(git -C "${core_source_dir}" diff --binary HEAD -- | sha256sum | cut -d ' ' -f 1)"
if [[ "${actual_core_diff}" != "${core_diff_sha256}" ]]; then
    echo "etas-core patch identity does not match the reviewed integration" >&2
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
printf 'RESULT expected-gap\n\n'

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
printf 'RESULT expected-gap\n\n'

if ! grep -Fq -- 'child.wait_with_output().await' "${command_source}"; then
    echo "locked LocalCommandClient implementation changed; re-audit ETAS-005" >&2
    exit 1
fi
if grep -Eq -- 'request\.budget|timeout_at|kill_on_drop|output_limit|max_output' "${command_source}"; then
    echo "locked LocalCommandClient gained lifecycle or output controls; re-audit ETAS-005" >&2
    exit 1
fi
printf '%s\n' \
    'CASE locked_command_lifecycle_source' \
    'RESULT expected-gap' \
    'DETAIL direct wait_with_output; no budget/deadline, cancellation cleanup, or output-limit control' \
    ''

cp -R "${fixture_root}/host_probe" "${case_root}/host_probe"
NOMO_GATEWAY_CLIENT_TOKEN="ETAS005_PUBLIC_SENTINEL" cargo run --quiet --offline \
    --manifest-path "${case_root}/host_probe/Cargo.toml" \
    --target-dir "${case_root}/target"

fixture_bytes="$(du -sb "${fixture_root}" | cut -f 1)"
printf 'ARTIFACT fixture_bytes=%s\n' "${fixture_bytes}"
echo "ETAS-005 verification completed: CLI surface plus host command matrix"
