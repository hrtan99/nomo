#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas004"
readonly surface_project="${fixture_root}/file_project"
readonly core_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-core-src"
readonly core_revision="64997eedc8436e9a9124b41e2e0de4723dafa056"
readonly core_tree="7063d934e85499c9b74a90d4876ccdec0f31d097"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas004.XXXXXX")"
readonly runtime_root="/tmp/nomo-etas004/workspace"

cleanup() {
    rm -rf -- "${case_root}" /tmp/nomo-etas004
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

mkdir -p "${runtime_root}"
etas check "${surface_project}"
set +e
etas check --phase1 "${surface_project}" \
    >"${case_root}/phase1.stdout" 2>"${case_root}/phase1.stderr"
phase1_exit=$?
set -e
if [[ "${phase1_exit}" -ne 1 ]] \
    || ! grep -Fq -- 'RuntimeRequiredInPhase1' "${case_root}/phase1.stderr"; then
    echo "expected the filesystem surface to require a Phase 1 host" >&2
    exit 1
fi
printf 'CASE cli_phase1_fileio_requirement\nEXIT %s\nRESULT pass\n\n' "${phase1_exit}"
etas run "${surface_project}" --profile readwrite --allow-effects \
    --print-runtime-profile >"${case_root}/runtime-profile.json"
python3 - "${case_root}/runtime-profile.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as profile_file:
    profile = json.load(profile_file)
assert profile["filesystem"] == "ReadWrite"
assert profile["workspace_root"] == "/tmp/nomo-etas004/workspace"
assert profile["policy"] == "LocalStatic"
assert profile["program_network_endpoints"] == []
assert profile["command_programs"] == []
print(f"runtime_profile_fingerprint={profile['profile_fingerprint']}")
PY

set +e
cp "${fixture_root}/constructor_gap.es" "${case_root}/constructor_gap.es"
etas check "${case_root}/constructor_gap.es" \
    >"${case_root}/constructor-gap.stdout" 2>"${case_root}/constructor-gap.stderr"
constructor_exit=$?
set -e
if [[ "${constructor_exit}" -ne 1 ]]; then
    echo "expected WorkspacePath construction probe to exit 1, got ${constructor_exit}" >&2
    exit 1
fi
if ! grep -Fq -- 'is not assignable' "${case_root}/constructor-gap.stderr"; then
    echo "WorkspacePath construction probe did not emit the expected type diagnostic" >&2
    exit 1
fi
printf 'CASE cli_workspace_path_constructor\nEXIT %s\n' "${constructor_exit}"
sed 's/^/STDERR: /' "${case_root}/constructor-gap.stderr"
printf 'RESULT expected-gap\n\n'

cp -R "${fixture_root}/host_probe" "${case_root}/host_probe"
cargo run --quiet --offline \
    --manifest-path "${case_root}/host_probe/Cargo.toml" \
    --target-dir "${case_root}/target"

echo "ETAS-004 verification completed: CLI surface plus 8 host-boundary cases"
