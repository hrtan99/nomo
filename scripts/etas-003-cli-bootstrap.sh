#!/usr/bin/env bash
set -euo pipefail

readonly etas_repo_url="https://github.com/etas-project/etas.git"
readonly core_repo_url="https://github.com/etas-project/etas-core.git"
readonly etas_base_revision="3e4a0b0757d24ef9a9325ae8d7ce59d1720bffca"
readonly core_base_revision="a1636207a8c5c2aadbebf11543871ab058d86e00"
readonly etas_deadline_revision="1f8ee64fa5acbd450be37cd7044ac926213c76b5"
readonly etas_thinking_revision="abe813eb17b761e008af24858467b03ae739618f"
readonly core_deadline_revision="3d5097062549fcd6ad07000f52ce386fb492e56d"
readonly core_thinking_revision="b687582271e18cf878125af8d8f8a87ba5a23797"
readonly etas_patch_sha256="bfb47a7127c2cd212aeb69267858e078896d5eec557736cb63e75facaa25334c"
readonly core_patch_sha256="88f59a984be92faad7e83e0812568f1c42ae8efe93f17646aab35135ca3770e7"
readonly etas_diff_sha256="aa0c96adb30b68f1f39883fa544f150b3d652195daf9204b59f5982d3e824bb6"
readonly core_diff_sha256="f6645ad702a04f11d571ab18fa5d81b34093fedd858d788f5eb5bcd93ad089a2"
readonly cargo_lock_sha256="f2c001fcd3227fcedc9f6c32c83ee3c512d4fedf695f011b4f89dbfbb300d550"
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-cli-src"
readonly core_source_dir="${CARGO_HOME}/etas003-core-src"
readonly etas_patch="${project_root}/patches/etas-003/etas-cli-combined.patch.gz"
readonly core_patch="${project_root}/patches/etas-003/etas-core-combined.patch.gz"
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
    local base_revision="$2"
    local source_dir="$3"
    local patch_path="$4"
    local patch_sha256="$5"
    local deadline_revision="$6"
    local thinking_revision="$7"
    local diff_sha256="$8"
    local allowed_untracked="$9"

    verify_sha256 "${patch_sha256}" "${patch_path}"
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
    if ! /usr/bin/git -C "${source_dir}" cat-file -e "${base_revision}^{commit}"; then
        /usr/bin/git -C "${source_dir}" fetch --depth 1 origin "${base_revision}"
    fi
    for feature_revision in "${deadline_revision}" "${thinking_revision}"; do
        if ! /usr/bin/git -C "${source_dir}" cat-file -e "${feature_revision}^{commit}"; then
            /usr/bin/git -C "${source_dir}" fetch --depth 1 origin "${feature_revision}"
        fi
    done
    /usr/bin/git -c core.hooksPath=/dev/null -C "${source_dir}" \
        checkout --detach "${base_revision}"
    if [[ "$(/usr/bin/git -C "${source_dir}" rev-parse HEAD)" != "${base_revision}" ]]; then
        echo "checkout did not resolve to ${base_revision}" >&2
        exit 1
    fi
    local untracked
    untracked="$(/usr/bin/git -C "${source_dir}" ls-files --others --exclude-standard)"
    if [[ "${untracked}" != "${allowed_untracked}" ]]; then
        echo "unexpected untracked source in ${source_dir}: ${untracked}" >&2
        exit 1
    fi

    if /usr/bin/git -C "${source_dir}" diff --quiet --; then
        /usr/bin/gzip --decompress --stdout "${patch_path}" \
            | /usr/bin/git -C "${source_dir}" apply --check -
        /usr/bin/gzip --decompress --stdout "${patch_path}" \
            | /usr/bin/git -C "${source_dir}" apply -
    fi
    local actual_patch_sha256
    actual_patch_sha256="$(/usr/bin/git -C "${source_dir}" diff --binary -- \
        | /usr/bin/sha256sum | cut -d ' ' -f 1)"
    if [[ "${actual_patch_sha256}" != "${diff_sha256}" ]]; then
        echo "patched source drifted in ${source_dir}" >&2
        exit 1
    fi
}

prepare_checkout \
    "${core_repo_url}" "${core_base_revision}" "${core_source_dir}" \
    "${core_patch}" "${core_patch_sha256}" \
    "${core_deadline_revision}" "${core_thinking_revision}" "${core_diff_sha256}" ""
prepare_checkout \
    "${etas_repo_url}" "${etas_base_revision}" "${etas_source_dir}" \
    "${etas_patch}" "${etas_patch_sha256}" \
    "${etas_deadline_revision}" "${etas_thinking_revision}" "${etas_diff_sha256}" "Cargo.lock"

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
printf 'etas_base=%s\netas_deadline=%s\netas_thinking=%s\n' \
    "${etas_base_revision}" "${etas_deadline_revision}" "${etas_thinking_revision}"
printf 'core_base=%s\ncore_deadline=%s\ncore_thinking=%s\n' \
    "${core_base_revision}" "${core_deadline_revision}" "${core_thinking_revision}"
printf 'etas_patch_sha256=%s\ncore_patch_sha256=%s\ncargo_lock_sha256=%s\n' \
    "${etas_patch_sha256}" "${core_patch_sha256}" "${cargo_lock_sha256}"
"${etas_binary}" --version
/usr/bin/sha256sum "${etas_binary}"
