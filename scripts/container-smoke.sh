#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

exec docker compose \
    --file "${project_root}/compose.yaml" \
    run \
    --rm \
    --no-deps \
    --tty=false \
    dev \
    /bin/bash -euo pipefail -c '
        grep -q "^VERSION_ID=\"26.04\"$" /etc/os-release
        test "$(uname -m)" = "aarch64"
        test "$(id -u)" = "10001"
        test "$(id -g)" = "10001"
        test ! -w /
        test -w /workspace
        test -w /tmp
        test ! -e /var/run/docker.sock
        case ",$(findmnt -no OPTIONS /)," in
            *,ro,*) ;;
            *) echo "container root filesystem is not read-only" >&2; exit 1 ;;
        esac
        test "$(cat /proc/1/comm)" = "docker-init"
        test "$(awk "/^NoNewPrivs:/ { print \$2 }" /proc/self/status)" = "1"
        test "$(awk "/^CapEff:/ { print \$2 }" /proc/self/status)" = "0000000000000000"
        test "$(cat /sys/fs/cgroup/memory.max)" = "4294967296"
        test "$(cat /sys/fs/cgroup/pids.max)" = "256"
        test "$(cat /sys/fs/cgroup/cpu.max)" = "400000 100000"
        if curl --silent --show-error --connect-timeout 2 --max-time 3 https://example.com >/dev/null 2>&1; then
            echo "default container unexpectedly has network access" >&2
            exit 1
        fi
        printf "os=%s arch=%s uid=%s gid=%s\n" \
            "$(. /etc/os-release && printf "%s" "${PRETTY_NAME}")" \
            "$(uname -m)" \
            "$(id -u)" \
            "$(id -g)"
        rustc --version
        cargo --version
        git --version
        rg --version | sed -n "1p"
        echo "security=read-only-root,no-new-privileges,cap-drop-all,network-none"
    '
