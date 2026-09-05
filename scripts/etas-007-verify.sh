#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas007"
readonly cargo_patch_config="${project_root}/config/etas-003-cargo-patch.toml"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-cli-src"
readonly core_source_dir="${CARGO_HOME}/etas003-core-src"
readonly interpreter_source_dir="${CARGO_HOME}/git/checkouts/etas-interpreter-d9a8cde496090f26/a5252c9"
readonly etas_revision="e8a38bc86ad9a5d9706da6f3c28735d29203e555"
readonly etas_tree="d6db6a20a35dd0130cfc9d4732da99e3469fc834"
readonly core_revision="64997eedc8436e9a9124b41e2e0de4723dafa056"
readonly core_tree="7063d934e85499c9b74a90d4876ccdec0f31d097"
readonly interpreter_revision="a5252c9c60f96327b91cb6647ef4fc4ef8404799"
readonly cargo_lock_sha256="f2c001fcd3227fcedc9f6c32c83ee3c512d4fedf695f011b4f89dbfbb300d550"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas007.XXXXXX")"

cleanup() {
    rm -rf -- "${case_root}"
}
trap cleanup EXIT

verify_checkout() {
    local source_dir="$1"
    local revision="$2"
    local tree="${3:-}"

    [[ "$(git -C "${source_dir}" rev-parse HEAD)" == "${revision}" ]]
    if [[ -n "${tree}" ]]; then
        [[ "$(git -C "${source_dir}" rev-parse HEAD^{tree})" == "${tree}" ]]
    fi
    git -C "${source_dir}" diff --quiet HEAD --
    git -C "${source_dir}" diff --cached --quiet HEAD --
}

verify_checkout "${etas_source_dir}" "${etas_revision}" "${etas_tree}"
verify_checkout "${core_source_dir}" "${core_revision}" "${core_tree}"
verify_checkout "${interpreter_source_dir}" "${interpreter_revision}"
printf '%s  %s\n' "${cargo_lock_sha256}" "${etas_source_dir}/Cargo.lock" \
    | sha256sum --check --status

readonly checkpoint_writer="${etas_source_dir}/crates/etas_cli/src/command/interpreter/checkpoint.rs"
readonly resume_command="${etas_source_dir}/crates/etas_cli/src/command/resume.rs"
readonly checkpoint_identity="${interpreter_source_dir}/crates/etas_interpreter/src/orchestration/identity.rs"
readonly completed_boundary="${interpreter_source_dir}/crates/etas_interpreter/src/orchestration/checkpoint.rs"

grep -Fq -- 'std::fs::rename(&tmp, path)' "${checkpoint_writer}"
grep -Fq -- 'current host runtime profile is not compatible with the checkpoint' \
    "${resume_command}"
grep -Fq -- 'etas.cli.interpreter-checkpoint.v15' "${checkpoint_identity}"
grep -Fq -- 'pub enum CompletedHostBoundaryResult' "${completed_boundary}"
if grep -Fq -- 'write_checkpoint_files' "${resume_command}"; then
    echo "locked resume command unexpectedly persists new checkpoints" >&2
    exit 1
fi
printf 'CASE checkpoint_implementation_surface\nEXIT 0\nRESULT pass\n\n'

python3 "${fixture_root}/checkpoint_probe.py" \
    --etas "$(command -v etas)" \
    --fixture "${fixture_root}/checkpoint_project" \
    --work-root "${case_root}/cli-probe"

cp -R "${interpreter_source_dir}" "${case_root}/interpreter"
cp "${etas_source_dir}/Cargo.lock" "${case_root}/interpreter/Cargo.lock"
for filter in \
    resume_checkpoint_continues_from_saved_state \
    checkpoint_budget_snapshot_does_not_change_after_later_token_consumption \
    resume_checkpoint_preserves_consumed_execution_fuel_and_cannot_widen_limits \
    resume_checkpoint_keeps_monotonic_checkpoint_ids \
    resume_checkpoint_preserves_completed_host_boundary_ledger \
    resume_checkpoint_revalidates_approval_under_current_authority \
    resume_checkpoint_reuses_completed_memory_get_boundary_result \
    resume_checkpoint_rejects_stale_memory_get_replay
do
    cargo test --quiet --offline \
        --config "${cargo_patch_config}" \
        --manifest-path "${case_root}/interpreter/Cargo.toml" \
        --target-dir "${case_root}/interpreter-target" \
        "${filter}"
    printf 'CASE interpreter_%s\nEXIT 0\nRESULT pass\n\n' "${filter}"
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
    "#12ec1aa27e215e750d8cc9eb26633743609788e2"
)
print("CASE interpreter_dependency_identity")
print("EXIT 0")
print("RESULT pass\n")
PY

fixture_bytes="$(du -sb "${fixture_root}" | cut -f 1)"
printf 'ARTIFACT fixture_bytes=%s\n' "${fixture_bytes}"
echo "ETAS-007 verification completed: 11 CLI passes, 3 bounded gaps, and 8 interpreter regressions"
