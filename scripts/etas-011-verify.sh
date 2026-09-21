#!/usr/bin/env bash
# ETAS-011: isolated candidate assessment, not a merged dependency migration.
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly mode="${1:?usage: etas-011-verify.sh prepare|verify CANDIDATE_DIRECTORY}"
readonly candidate="$(realpath "${2:?candidate directory containing core and interpreter clones}")"
readonly core_revision=3d727dd0c9e781c3607fb72029c3edf3c68f3331
readonly interpreter_revision=8f955f41504c450e5623ea5ae28e3d736be6acd6
readonly build="${candidate}/assessment"

case "${candidate}" in
    "${CARGO_HOME:?}/nomo-etas011."*) ;;
    *) echo 'expected an isolated nomo-etas011.* directory under CARGO_HOME' >&2; exit 1 ;;
esac
case "${mode}" in prepare|verify) ;; *) exit 2 ;; esac
[[ "$(git -C "${candidate}/core" rev-parse HEAD)" == "${core_revision}" ]]
[[ "$(git -C "${candidate}/interpreter" rev-parse HEAD)" == "${interpreter_revision}" ]]
for repository in core interpreter; do
    git -C "${candidate}/${repository}" diff --exit-code HEAD --
done

patches=()
for crate in etas_builtin etas_cache etas_core etas_host etas_package_metadata etas_std etas_utils; do
    patches+=(--config "patch.\"https://github.com/etas-project/etas-core.git\".${crate}.path=\"${build}/core/crates/${crate}\"")
done

if [[ "${mode}" == prepare ]]; then
    # mkdir deliberately refuses to overwrite a previous assessment.
    mkdir "${build}"
    for repository in core interpreter; do
        mkdir "${build}/${repository}"
        git -C "${candidate}/${repository}" archive HEAD | tar -x -C "${build}/${repository}"
    done
    cp "${project_root}/patches/etas-003/Cargo.lock" "${build}/interpreter/Cargo.lock"
    for item in 005 006 011; do
        cp -R "${project_root}/tests/fixtures/etas${item}/host_probe" "${build}/probe${item}"
        cp "${project_root}/patches/etas-003/Cargo.lock" "${build}/probe${item}/Cargo.lock"
        # Mechanical path substitution only; preserve the existing probe assertions.
        sed -i "s|/home/nomo/.cargo/etas003-core-src|${build}/core|g" "${build}/probe${item}/Cargo.toml"
    done
    for repository in core interpreter probe005 probe006 probe011; do
        config=()
        [[ "${repository}" != interpreter ]] || config=("${patches[@]}")
        cargo fetch --manifest-path "${build}/${repository}/Cargo.toml" "${config[@]}"
    done
    echo "ETAS-011 prepared: ${build}; run verify in the network-disabled dev service"
    exit 0
fi

# Verify archived source identity, including protection against edited test assertions.
for repository in core interpreter; do
    while IFS= read -r -d '' file; do
        [[ "${file}" == Cargo.lock ]] && continue
        git -C "${candidate}/${repository}" show "HEAD:${file}" | cmp - "${build}/${repository}/${file}"
    done < <(git -C "${candidate}/${repository}" ls-files -z)
done

run_tests() {
    local repository="$1" package="$2"
    local config=()
    [[ "${repository}" != interpreter ]] || config=("${patches[@]}")
    timeout 300 cargo test --offline --locked \
        --manifest-path "${build}/${repository}/Cargo.toml" "${config[@]}" \
        --target-dir "${build}/target" --package "${package}" \
        | tee "${build}/${repository}-test.log"
    grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "${build}/${repository}-test.log"
}
run_tests core etas_host
run_tests interpreter etas_interpreter
for item in 005 006 011; do
    cmp "${project_root}/tests/fixtures/etas${item}/host_probe/src/main.rs" "${build}/probe${item}/src/main.rs"
    sed "s|/home/nomo/.cargo/etas003-core-src|${build}/core|g" \
        "${project_root}/tests/fixtures/etas${item}/host_probe/Cargo.toml" \
        | cmp - "${build}/probe${item}/Cargo.toml"
    timeout 300 cargo run --offline --locked \
        --manifest-path "${build}/probe${item}/Cargo.toml" \
        --target-dir "${build}/target" | tee "${build}/probe${item}-test.log"
done
sha256sum "${build}"/{core,interpreter,probe005,probe006,probe011}/Cargo.lock
echo 'ETAS-011 candidate assessment passed; normal ETAS-010 dependencies were not migrated'
