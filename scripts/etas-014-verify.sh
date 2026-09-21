#!/usr/bin/env bash
set -euo pipefail
readonly project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
printf '%s  %s\n' 0dead4ce2fd435a2c711629a7197bc0da041ed7ad2ff241f2f4f9b3ef17fbaad "${CARGO_HOME:?}/bin/etas" | sha256sum --check --status
printf '%s  %s\n' 3e8bfec4e09a57b52bcf4bb29f9e8c394eb91e23eadf1eb8287de9a2ff8e60d1 "${project_root}/patches/etas-003/Cargo.lock" | sha256sum --check --status
printf '%s  %s\n' f127a6476f3e3295be20913c92c2d45d32a6d84625d33ac8d530b7cf5e78c33b "${project_root}/etas.lock" | sha256sum --check --status
timeout 60 python3 -B "${project_root}/tests/fixtures/etas014/call_form_probe.py"
python3 -B "${project_root}/scripts/count-sloc.py"
