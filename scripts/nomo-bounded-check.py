#!/usr/bin/env python3
"""Run a check, forwarding a bounded prefix of each output stream."""
import os
import selectors
import subprocess
import sys

STREAM_LIMIT = 16 * 1024


def main(argv):
    if not argv:
        print('A check command is required.', file=sys.stderr)
        return 64
    try:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, close_fds=True)
    except OSError as error:
        message = ('Cannot execute check: ' + str(error) + '\n').encode('utf-8', errors='backslashreplace')
        sys.stderr.buffer.write(message[:STREAM_LIMIT])
        if len(message) > STREAM_LIMIT:
            sys.stderr.buffer.write(b'\n[nomo: stderr truncated after 16384 bytes]\n')
        sys.stderr.buffer.flush()
        return 127
    selector = selectors.DefaultSelector()
    outputs = {child.stdout: [sys.stdout.buffer, 0, False, 'stdout'],
               child.stderr: [sys.stderr.buffer, 0, False, 'stderr']}
    for stream in outputs:
        selector.register(stream, selectors.EVENT_READ)
    try:
        while selector.get_map():
            for key, _ in selector.select():
                stream = key.fileobj
                data = os.read(stream.fileno(), 65536)
                if not data:
                    selector.unregister(stream)
                    stream.close()
                    continue
                target, shown, truncated, name = outputs[stream]
                prefix = data[:max(0, STREAM_LIMIT - shown)]
                if prefix:
                    target.write(prefix)
                    target.flush()
                shown += len(prefix)
                if len(prefix) < len(data) and not truncated:
                    target.write(('\n[nomo: ' + name + ' truncated after ' + str(STREAM_LIMIT) + ' bytes]\n').encode())
                    target.flush()
                    truncated = True
                outputs[stream] = [target, shown, truncated, name]
        result = child.wait()
        return result if result >= 0 else 128 - result
    finally:
        selector.close()


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
