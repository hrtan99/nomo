#!/usr/bin/env bash
set -euo pipefail

readonly etas_repo_url="https://github.com/etas-project/etas.git"
readonly etas_cli_revision="3e4a0b0757d24ef9a9325ae8d7ce59d1720bffca"
readonly etas_cargo_lock_sha256="20ea8b50fcaf509cc85fed81d8a0191fe5f2a74be3d406ef502a3fd8cda4dfdf"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas-src"
readonly etas_binary="${CARGO_HOME}/bin/etas"
readonly etas_build_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for cargo_config in \
    "${CARGO_HOME}/config" \
    "${CARGO_HOME}/config.toml" \
    "/workspace/.cargo/config" \
    "/workspace/.cargo/config.toml" \
    "${etas_source_dir}/.cargo/config" \
    "${etas_source_dir}/.cargo/config.toml"
do
    if [[ -e "${cargo_config}" ]]; then
        echo "refusing to build with local Cargo configuration: ${cargo_config}" >&2
        exit 1
    fi
done

if [[ ! -d "${etas_source_dir}/.git" ]]; then
    if [[ -e "${etas_source_dir}" ]]; then
        echo "refusing to replace non-Git path: ${etas_source_dir}" >&2
        exit 1
    fi
    /usr/bin/git clone "${etas_repo_url}" "${etas_source_dir}"
fi

if [[ "$(/usr/bin/git -C "${etas_source_dir}" remote get-url origin)" != "${etas_repo_url}" ]]; then
    echo "unexpected Etas origin in ${etas_source_dir}" >&2
    exit 1
fi

source_status="$(/usr/bin/git -C "${etas_source_dir}" status --porcelain --untracked-files=all)"
if [[ -n "${source_status}" && "${source_status}" != "?? Cargo.lock" ]]; then
    echo "refusing to build from a modified Etas checkout:" >&2
    printf '%s\n' "${source_status}" >&2
    exit 1
fi

if ! /usr/bin/git -C "${etas_source_dir}" cat-file -e "${etas_cli_revision}^{commit}"; then
    /usr/bin/git -C "${etas_source_dir}" fetch --depth 1 origin "${etas_cli_revision}"
fi

/usr/bin/git -c core.hooksPath=/dev/null \
    -C "${etas_source_dir}" checkout --detach "${etas_cli_revision}"

if [[ "$(/usr/bin/git -C "${etas_source_dir}" rev-parse HEAD)" != "${etas_cli_revision}" ]]; then
    echo "Etas checkout did not resolve to the required revision" >&2
    exit 1
fi

if [[ ! -f "${etas_source_dir}/Cargo.lock" ]]; then
    PATH="${etas_build_path}" /usr/bin/cargo generate-lockfile \
        --manifest-path "${etas_source_dir}/Cargo.toml"
fi

printf '%s  %s\n' "${etas_cargo_lock_sha256}" "${etas_source_dir}/Cargo.lock" \
    | /usr/bin/sha256sum --check --status \
    || {
        echo "Etas CLI dependency lock drifted; review before updating the baseline" >&2
        exit 1
    }

PATH="${etas_build_path}" /usr/bin/cargo build \
    --manifest-path "${etas_source_dir}/Cargo.toml" \
    --locked \
    --release \
    --package etas_cli \
    --all-features

/usr/bin/install -D -m 0755 "${etas_source_dir}/target/release/etas" "${etas_binary}"
"${etas_binary}" --version
/usr/bin/sha256sum "${etas_binary}"
