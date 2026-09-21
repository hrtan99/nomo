#!/usr/bin/env bash
set -euo pipefail

# Keep the historical reproducer below; use this mode on the merged Nomo baseline.
if [[ "${1:-}" == "--verify-fixed" ]]; then
    project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
    exec bash "${project_root}/scripts/etas-005-verify.sh"
fi

readonly repro_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly core_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-core-src"
readonly command_source="${core_source_dir}/crates/etas_host/src/command/local.rs"
readonly core_base_revision="a1636207a8c5c2aadbebf11543871ab058d86e00"
readonly core_diff_sha256="f6645ad702a04f11d571ab18fa5d81b34093fedd858d788f5eb5bcd93ad089a2"
readonly run_root="$(mktemp -d "${CARGO_HOME}/etas-command-resource-bounds.XXXXXX")"
trap 'rm -rf -- "${run_root}"' EXIT

if [[ "$(git -C "${core_source_dir}" rev-parse HEAD)" != "${core_base_revision}" ]]; then
    echo "etas-core checkout does not match the recorded base" >&2
    exit 1
fi
actual_diff="$(git -C "${core_source_dir}" diff --binary HEAD -- | sha256sum | cut -d ' ' -f 1)"
if [[ "${actual_diff}" != "${core_diff_sha256}" ]]; then
    echo "etas-core working diff does not match the reviewed integration" >&2
    exit 1
fi
if ! grep -Fq 'child.wait_with_output().await' "${command_source}"; then
    echo "LocalCommandClient changed; re-audit this reproduction" >&2
    exit 1
fi
if grep -Eq 'request\.budget|timeout_at|output_limit|max_output' "${command_source}"; then
    echo "LocalCommandClient now appears to enforce a resource bound" >&2
    exit 1
fi

cp -R "${repro_root}/host_probe" "${run_root}/host_probe"
cargo run --quiet --offline \
    --manifest-path "${run_root}/host_probe/Cargo.toml" \
    --target-dir "${run_root}/target"
