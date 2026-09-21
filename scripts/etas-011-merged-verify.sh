#!/usr/bin/env bash
# ETAS-011 post-fix tests on the normal merged dependency graph.
set -euo pipefail
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly core_source="${CARGO_HOME:?}/etas003-core-src"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas011-tests.XXXXXX")"
trap 'rm -rf -- "${case_root}"' EXIT
[[ "$(git -C "${core_source}" rev-parse HEAD)" == 9c9d3a17b007745c81e03bb49c977c9f65454b6f ]]
git -C "${core_source}" diff --exit-code HEAD --
git -C "${core_source}" diff --cached --exit-code HEAD --
mkdir "${case_root}/core"
git -C "${core_source}" archive HEAD | tar -x -C "${case_root}/core"
cp "${project_root}/patches/etas-003/Cargo.lock" "${case_root}/core/Cargo.lock"
timeout 300 cargo test --offline --manifest-path "${case_root}/core/Cargo.toml" \
    --package etas_host --target-dir "${case_root}/target" | tee "${case_root}/host.log"
grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "${case_root}/host.log"
cp -R "${project_root}/tests/fixtures/etas011/host_probe" "${case_root}/probe"
cp "${project_root}/patches/etas-003/Cargo.lock" "${case_root}/probe/Cargo.lock"
timeout 300 cargo run --offline --manifest-path "${case_root}/probe/Cargo.toml" \
    --target-dir "${case_root}/target"
NOMO_GATEWAY_CLIENT_TOKEN=ETAS011_PUBLIC_SENTINEL \
    python3 "${project_root}/tests/fixtures/etas011/checkpoint_probe.py"
echo 'ETAS-011 merged Host/File/checkpoint regression passed'
