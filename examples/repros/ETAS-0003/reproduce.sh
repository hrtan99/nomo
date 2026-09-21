#!/usr/bin/env bash
set -euo pipefail

# Keep the historical reproducer below; use this mode on the merged Nomo baseline.
if [[ "${1:-}" == "--verify-fixed" ]]; then
    project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
    exec python3 "${project_root}/tests/fixtures/etas010/source_probe.py"
fi

readonly repro_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly run_root="$(mktemp -d /tmp/etas-workspace-path-reachability.XXXXXX)"
trap 'rm -rf -- "${run_root}"' EXIT

set +e
etas check "${repro_root}" >"${run_root}/stdout" 2>"${run_root}/stderr"
status=$?
set -e

sed 's/^/STDOUT: /' "${run_root}/stdout"
sed 's/^/STDERR: /' "${run_root}/stderr"
echo "EXIT: ${status}"

if [[ "${status}" -ne 1 ]]; then
    echo "expected Etas checker exit 1" >&2
    exit 1
fi
if ! grep -Fq 'is not assignable' "${run_root}/stderr" \
    || ! grep -Fq 'WorkspacePath<ReproRoot>' "${run_root}/stderr"; then
    echo "expected WorkspacePath construction type diagnostic" >&2
    exit 1
fi

echo "ETAS-0003 reproduced: checked source cannot construct WorkspacePath"
