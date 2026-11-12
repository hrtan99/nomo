#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec docker compose --env-file /dev/null \
  --file "$task_root/compose.yaml" \
  --file "$task_root/config/etas-0133-official-compose.yaml" \
  run --rm --no-deps --pull never --tty=false dependency /bin/bash -c '
    set -euo pipefail
    tool_root=/home/nomo/.cargo/nomo-native-tools/taplo-0.10.0
    if [[ -x "$tool_root/bin/taplo" ]] && [[ "$("$tool_root/bin/taplo" --version)" == "taplo 0.10.0" ]]; then
      "$tool_root/bin/taplo" --version
      exit 0
    fi
    cargo install taplo-cli --version 0.10.0 --locked --no-default-features \
      --root "$tool_root" --target-dir "$tool_root/target"
    "$tool_root/bin/taplo" --version
  '
