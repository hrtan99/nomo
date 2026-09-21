#!/usr/bin/env bash
set -euo pipefail

# Keep the historical reproducer below; use this mode on the merged Nomo baseline.
if [[ "${1:-}" == "--verify-fixed" ]]; then
    project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
    exec python3 "${project_root}/tests/fixtures/etas010/source_probe.py"
fi

readonly repro_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly run_root="$(mktemp -d /tmp/etas-command-reachability.XXXXXX)"
trap 'rm -rf -- "${run_root}"' EXIT

etas check "${repro_root}"
cp "${repro_root}/constructor_gap.es" "${run_root}/constructor_gap.es"

set +e
etas check "${run_root}/constructor_gap.es" \
    >"${run_root}/constructor.stdout" 2>"${run_root}/constructor.stderr"
constructor_status=$?
etas run "${repro_root}" --flow run_command --profile command --allow-effects \
    --args /bin/sh >"${run_root}/entry.stdout" 2>"${run_root}/entry.stderr"
entry_status=$?
set -e

sed 's/^/CONSTRUCTOR_STDERR: /' "${run_root}/constructor.stderr"
echo "CONSTRUCTOR_EXIT: ${constructor_status}"
sed 's/^/ENTRY_STDERR: /' "${run_root}/entry.stderr"
echo "ENTRY_EXIT: ${entry_status}"

if [[ "${constructor_status}" -ne 1 ]] \
    || ! grep -Fq 'is not assignable to `std.host.command.Command`' \
        "${run_root}/constructor.stderr"; then
    echo "expected Command construction type diagnostic" >&2
    exit 1
fi
if [[ "${entry_status}" -ne 1 ]] \
    || ! grep -Fq 'must resolve to `flow run_command(args: Array[string]) -> i32`' \
        "${run_root}/entry.stderr"; then
    echo "expected fixed CLI entry-signature diagnostic" >&2
    exit 1
fi

echo "ETAS-0007 reproduced: source construction and CLI typed injection are unavailable"
