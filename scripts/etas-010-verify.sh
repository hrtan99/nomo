#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly core_source="${CARGO_HOME:?}/etas003-core-src"
readonly interpreter_source="${CARGO_HOME}/git/checkouts/etas-interpreter-d9a8cde496090f26/5de9203"
readonly case_root="$(mktemp -d "${CARGO_HOME}/nomo-etas010-tests.XXXXXX")"
trap 'rm -rf -- "${case_root}"' EXIT

[[ "$(git -C "${core_source}" rev-parse HEAD)" == 9c9d3a17b007745c81e03bb49c977c9f65454b6f ]]
[[ "$(git -C "${interpreter_source}" rev-parse HEAD)" == 5de9203109c75746f53e8e6bd8083fbd932f73bc ]]
for source in "${core_source}" "${interpreter_source}"; do
    git -C "${source}" diff --quiet HEAD --
    git -C "${source}" diff --cached --quiet HEAD --
done

NOMO_GATEWAY_CLIENT_TOKEN=ETAS010_PUBLIC_SENTINEL \
    python3 "${project_root}/tests/fixtures/etas010/source_probe.py"

# Archive only tracked upstream files; build isolated copies, never alter their source.
mkdir "${case_root}/core" "${case_root}/interpreter"
git -C "${core_source}" archive HEAD | tar -x -C "${case_root}/core"
git -C "${interpreter_source}" archive HEAD | tar -x -C "${case_root}/interpreter"
cp "${project_root}/patches/etas-003/Cargo.lock" "${case_root}/core/Cargo.lock"
cp "${project_root}/patches/etas-003/Cargo.lock" "${case_root}/interpreter/Cargo.lock"

for filter in command console::local_stdio filesystem; do
    cargo test --offline --manifest-path "${case_root}/core/Cargo.toml" \
        --package etas_host --target-dir "${case_root}/target" "${filter}" \
        | tee "${case_root}/host-test.log"
    grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "${case_root}/host-test.log"
done

# Full interpreter suite includes occurrence-based replay, repeated identical I/O,
# authority, budgets, and configured command/path constructor tests.
cargo test --offline --manifest-path "${case_root}/interpreter/Cargo.toml" \
    --config "${project_root}/config/etas-003-cargo-patch.toml" \
    --target-dir "${case_root}/target" --package etas_interpreter \
    | tee "${case_root}/interpreter-test.log"
grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "${case_root}/interpreter-test.log"
echo 'ETAS-010 source/Host/interpreter regression passed'
