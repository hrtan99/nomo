#!/usr/bin/env bash
set -euo pipefail

readonly etas_repo_url="https://github.com/etas-project/etas.git"
readonly core_repo_url="https://github.com/etas-project/etas-core.git"
readonly etas_revision="e8a38bc86ad9a5d9706da6f3c28735d29203e555"
readonly etas_tree="d6db6a20a35dd0130cfc9d4732da99e3469fc834"
readonly core_revision="64997eedc8436e9a9124b41e2e0de4723dafa056"
readonly core_tree="7063d934e85499c9b74a90d4876ccdec0f31d097"
readonly cargo_lock_sha256="f2c001fcd3227fcedc9f6c32c83ee3c512d4fedf695f011b4f89dbfbb300d550"
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-cli-src"
readonly core_source_dir="${CARGO_HOME}/etas003-core-src"
readonly locked_cargo_lock="${project_root}/patches/etas-003/Cargo.lock"
readonly cargo_patch_config="${project_root}/config/etas-003-cargo-patch.toml"
readonly etas_binary="${CARGO_HOME}/bin/etas"
readonly build_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for cargo_config in \
    "${CARGO_HOME}/config" \
    "${CARGO_HOME}/config.toml" \
    "/workspace/.cargo/config" \
    "/workspace/.cargo/config.toml"
do
    if [[ -e "${cargo_config}" ]]; then
        echo "refusing to build with local Cargo configuration: ${cargo_config}" >&2
        exit 1
    fi
done

verify_sha256() {
    local expected="$1"
    local path="$2"
    printf '%s  %s\n' "${expected}" "${path}" | /usr/bin/sha256sum --check --status
}

prepare_checkout() {
    local repo_url="$1"
    local revision="$2"
    local source_dir="$3"
    local expected_tree="$4"
    local allowed_untracked="$5"

    if [[ ! -d "${source_dir}/.git" ]]; then
        if [[ -e "${source_dir}" ]]; then
            echo "refusing to replace non-Git path: ${source_dir}" >&2
            exit 1
        fi
        /usr/bin/git clone "${repo_url}" "${source_dir}"
    fi
    if [[ "$(/usr/bin/git -C "${source_dir}" remote get-url origin)" != "${repo_url}" ]]; then
        echo "unexpected origin in ${source_dir}" >&2
        exit 1
    fi
    if ! /usr/bin/git -C "${source_dir}" diff --cached --quiet HEAD --; then
        echo "refusing tracked index drift from locked HEAD in ${source_dir}" >&2
        exit 1
    fi
    if ! /usr/bin/git -C "${source_dir}" diff --quiet HEAD --; then
        echo "refusing tracked worktree drift from locked HEAD in ${source_dir}" >&2
        exit 1
    fi
    local untracked
    untracked="$(/usr/bin/git -C "${source_dir}" ls-files --others --exclude-standard)"
    if [[ -n "${untracked}" && "${untracked}" != "${allowed_untracked}" ]]; then
        echo "unexpected untracked source in ${source_dir}: ${untracked}" >&2
        exit 1
    fi
    if ! /usr/bin/git -C "${source_dir}" cat-file -e "${revision}^{commit}"; then
        /usr/bin/git -C "${source_dir}" fetch --depth 1 origin "${revision}"
    fi
    /usr/bin/git -c core.hooksPath=/dev/null -C "${source_dir}" \
        checkout --detach "${revision}"
    if [[ "$(/usr/bin/git -C "${source_dir}" rev-parse HEAD)" != "${revision}" ]]; then
        echo "checkout did not resolve to ${revision}" >&2
        exit 1
    fi
    if [[ "$(/usr/bin/git -C "${source_dir}" rev-parse HEAD^{tree})" != "${expected_tree}" ]]; then
        echo "checkout tree does not match the locked identity in ${source_dir}" >&2
        exit 1
    fi
    if ! /usr/bin/git -C "${source_dir}" diff --quiet HEAD -- \
        || ! /usr/bin/git -C "${source_dir}" diff --cached --quiet HEAD --; then
        echo "checkout drifted after selecting ${revision} in ${source_dir}" >&2
        exit 1
    fi
}

prepare_checkout \
    "${core_repo_url}" "${core_revision}" "${core_source_dir}" "${core_tree}" ""
prepare_checkout \
    "${etas_repo_url}" "${etas_revision}" "${etas_source_dir}" "${etas_tree}" "Cargo.lock"

verify_sha256 "${cargo_lock_sha256}" "${locked_cargo_lock}"
/usr/bin/install -m 0644 "${locked_cargo_lock}" "${etas_source_dir}/Cargo.lock"

PATH="${build_path}" /usr/bin/cargo test \
    --manifest-path "${etas_source_dir}/Cargo.toml" \
    --config "${cargo_patch_config}" \
    --locked \
    --package etas_cli
PATH="${build_path}" /usr/bin/cargo build \
    --manifest-path "${etas_source_dir}/Cargo.toml" \
    --config "${cargo_patch_config}" \
    --locked \
    --release \
    --package etas_cli \
    --all-features

/usr/bin/install -D -m 0755 "${etas_source_dir}/target/release/etas" "${etas_binary}"
printf 'etas_revision=%s\netas_tree=%s\n' "${etas_revision}" "${etas_tree}"
printf 'core_revision=%s\ncore_tree=%s\n' "${core_revision}" "${core_tree}"
printf 'cargo_lock_sha256=%s\n' "${cargo_lock_sha256}"
"${etas_binary}" --version
/usr/bin/sha256sum "${etas_binary}"
