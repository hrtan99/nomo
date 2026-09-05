#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly fixture_root="${project_root}/tests/fixtures/etas008"
readonly line_project="${fixture_root}/line_project"
readonly single_line_project="${fixture_root}/single_line_project"
readonly approval_project="${fixture_root}/approval_project"
readonly etas_source_dir="${CARGO_HOME:?CARGO_HOME must be set}/etas003-cli-src"
readonly core_source_dir="${CARGO_HOME}/etas003-core-src"
readonly etas_revision="e8a38bc86ad9a5d9706da6f3c28735d29203e555"
readonly etas_tree="d6db6a20a35dd0130cfc9d4732da99e3469fc834"
readonly core_revision="64997eedc8436e9a9124b41e2e0de4723dafa056"
readonly core_tree="7063d934e85499c9b74a90d4876ccdec0f31d097"
readonly console_source="${core_source_dir}/crates/etas_host/src/console"
readonly cli_host_source="${etas_source_dir}/crates/etas_cli/src/command/interpreter/host.rs"

verify_checkout() {
    local source_dir="$1"
    local revision="$2"
    local tree="$3"

    [[ "$(git -C "${source_dir}" rev-parse HEAD)" == "${revision}" ]]
    [[ "$(git -C "${source_dir}" rev-parse HEAD^{tree})" == "${tree}" ]]
    git -C "${source_dir}" diff --quiet HEAD --
    git -C "${source_dir}" diff --cached --quiet HEAD --
}

verify_checkout "${etas_source_dir}" "${etas_revision}" "${etas_tree}"
verify_checkout "${core_source_dir}" "${core_revision}" "${core_tree}"

etas check "${line_project}"
etas check "${single_line_project}"
etas check "${approval_project}"
etas effects "${line_project}" > /tmp/etas008-effects.txt
for action in \
    Console.stdin_read_line \
    Console.stdout_write \
    Console.stderr_write
do
    grep -Fq -- "${action}" /tmp/etas008-effects.txt
done
rm -f /tmp/etas008-effects.txt

grep -Fq -- 'std::io::stdin().read_line(&mut input)' \
    "${console_source}/local_stdio.rs"
grep -Fq -- 'if !std::io::IsTerminal::is_terminal(&std::io::stdin())' \
    "${cli_host_source}"
if rg -i -q -- 'raw.mode|alternate.screen|cursor|mouse|full.screen' \
    "${console_source}"; then
    echo "unexpected rich-terminal operation in locked Console Host" >&2
    exit 1
fi

python3 "${fixture_root}/terminal_probe.py" \
    --etas "$(command -v etas)" \
    --line-project "${line_project}" \
    --single-line-project "${single_line_project}" \
    --approval-project "${approval_project}"

fixture_bytes="$(du -sb "${fixture_root}" | cut -f 1)"
printf 'ARTIFACT fixture_bytes=%s\n' "${fixture_bytes}"
echo "ETAS-008 verification completed: line I/O, EOF, approval, TTY/plain output, and cancellation measured"
