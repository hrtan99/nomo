#!/usr/bin/env python3
"""Own one terminal Compose client/container; application decisions stay in Etas."""
import os
import re
import signal
import subprocess
import sys
import time
import uuid

OWNER_LABEL = 'nomo.terminal.invocation'
CLIENT_GRACE = 2.0
CREATOR_REAP_GRACE = 1.0
STARTUP_OBSERVE_GRACE = 1.0
STOP_GRACE = 2
OP_TIMEOUT = 5.0
CLEANUP_TIMEOUT = 12.0
INSPECT = '{{.Id}}\n{{.Name}}\n{{index .Config.Labels "' + OWNER_LABEL + '"}}'


def main(arguments):
    if len(arguments) < 5 or arguments[:2] != ['docker', 'compose'] or 'run' not in arguments:
        print('terminal transport requires the fixed Compose run command', file=sys.stderr)
        return 64
    run_index = arguments.index('run')
    try:
        service_index = arguments.index('dev', run_index + 1)
    except ValueError:
        print('terminal transport requires the fixed dev service', file=sys.stderr)
        return 64
    owner = uuid.uuid4().hex
    name = 'nomo-terminal-' + owner
    command = arguments[:service_index] + ['--name', name, '--label', OWNER_LABEL + '=' + owner] + arguments[service_index:]
    requested = [0, 0.0]
    client = None
    observed_identifier = None

    def terminated(number, _frame):
        if not requested[0]:
            requested[:] = [number, time.monotonic()]

    def remaining(deadline):
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError('owned cleanup deadline exceeded')
        return min(OP_TIMEOUT, value)

    def docker(arguments, deadline):
        return subprocess.run(['docker', *arguments], stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=remaining(deadline))

    def inspect(identifier, deadline):
        nonlocal observed_identifier
        result = docker(['inspect', '--format', INSPECT, identifier], deadline)
        if result.returncode:
            # Distinguish absence from unavailable daemon/inspection; never guess success.
            if 'No such object:' in result.stderr or 'No such container:' in result.stderr:
                return 'missing', None
            return 'unknown', None
        fields = result.stdout.strip().splitlines()
        if len(fields) != 3 or not re.fullmatch('[0-9a-f]{64}', fields[0]):
            return 'unknown', None
        if fields[2] != owner or fields[1] != '/' + name:
            return 'foreign', None
        if identifier != name and fields[0] != identifier:
            return 'foreign', None
        if observed_identifier is not None and fields[0] != observed_identifier:
            return 'foreign', None
        observed_identifier = fields[0]
        return 'owned', fields[0]

    def clean_container(deadline, code):
        state, identifier = inspect(name, deadline)
        if state == 'missing':
            return True
        if state == 'foreign':
            return not requested[0] and code != 0 and observed_identifier is None
        if state != 'owned':
            return False
        state, found = inspect(identifier, deadline)
        if state == 'missing':
            return True
        if state != 'owned' or found != identifier:
            return False
        try:
            docker(['stop', '--time', str(STOP_GRACE), identifier], deadline)
        except subprocess.TimeoutExpired:
            pass  # Reinspect ownership and attempt removal within the same deadline.
        state, found = inspect(identifier, deadline)
        if state == 'missing':
            return True
        if state != 'owned' or found != identifier:
            return False
        docker(['rm', '--force', identifier], deadline)
        state, _ = inspect(identifier, deadline)
        return state == 'missing'

    def reconcile_container(deadline, code):
        # Only call after the owned creator has been reaped. Its earlier missing
        # result cannot close a create request still in flight inside the daemon.
        observe_until = min(deadline, time.monotonic() + STARTUP_OBSERVE_GRACE)
        while True:
            if not clean_container(deadline, code):
                return False
            state, _ = inspect(name, deadline)
            if state == 'owned':
                continue  # Creation became visible after a previous missing result.
            if state == 'foreign':
                return not requested[0] and code != 0 and observed_identifier is None
            if state != 'missing':
                return False
            if not requested[0] or observed_identifier is not None:
                return True
            if time.monotonic() >= observe_until:
                return False  # Startup cancellation with no observed creation is unproven.
            time.sleep(min(0.05, max(0, observe_until - time.monotonic())))

    def forward(number):
        if client is not None:
            try:
                os.killpg(client.pid, number)
            except ProcessLookupError:
                pass
            except OSError:
                return False
        return True

    def creator_group_settled(deadline):
        # Reaping the direct client alone does not prove its creator children ended.
        until = min(deadline, time.monotonic() + CREATOR_REAP_GRACE)
        killed = False
        while True:
            try:
                os.killpg(client.pid, 0)
            except ProcessLookupError:
                return True
            except OSError:
                return False
            if not killed:
                if not forward(signal.SIGKILL):
                    return False
                killed = True
            if time.monotonic() >= until:
                return False
            time.sleep(min(0.05, max(0, until - time.monotonic())))

    signal.signal(signal.SIGINT, terminated)
    signal.signal(signal.SIGTERM, terminated)
    code = 1
    cleanup_ok = True
    try:
        # A private process group scopes forwarding to this client and its children.
        # Standard descriptors are inherited unchanged; this helper reads no task/consent.
        client = subprocess.Popen(command, stdin=sys.stdin, stdout=sys.stdout,
                                  stderr=sys.stderr, start_new_session=True)
        next_observation = 0.0
        while client.poll() is None and not requested[0]:
            if observed_identifier is None and time.monotonic() >= next_observation:
                try:
                    inspect(name, time.monotonic() + STARTUP_OBSERVE_GRACE)
                except (OSError, subprocess.TimeoutExpired, TimeoutError):
                    pass  # Final reconciliation must establish closure independently.
                next_observation = time.monotonic() + 0.25
            time.sleep(0.05)
        if requested[0]:
            if not forward(requested[0]):
                cleanup_ok = False
        else:
            code = client.returncode
    except OSError:
        print('terminal transport owned client operation failed', file=sys.stderr)
    finally:
        deadline = (requested[1] if requested[0] else time.monotonic()) + CLEANUP_TIMEOUT
        if client is not None:
            if requested[0] and client.poll() is None:
                try:
                    client.wait(timeout=min(CLIENT_GRACE, remaining(deadline)))
                except (subprocess.TimeoutExpired, TimeoutError):
                    pass
            if client.poll() is None:
                if not forward(signal.SIGKILL):
                    cleanup_ok = False
                try:
                    client.wait(timeout=min(CREATOR_REAP_GRACE, remaining(deadline)))
                except (subprocess.TimeoutExpired, TimeoutError):
                    cleanup_ok = False
            creator_settled = client.poll() is not None and creator_group_settled(deadline)
            if not creator_settled:
                cleanup_ok = False
            else:
                if not requested[0]:
                    code = client.returncode
                try:
                    cleanup_ok = reconcile_container(deadline, code) and cleanup_ok
                except (OSError, subprocess.TimeoutExpired, TimeoutError):
                    cleanup_ok = False
    if not cleanup_ok:
        print('terminal transport owned cleanup is unconfirmed; inspect retained work before further action', file=sys.stderr)
        return 125
    if requested[0]:
        return 128 + requested[0]
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
