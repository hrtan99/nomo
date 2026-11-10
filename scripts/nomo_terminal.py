"""Human terminal presentation; protocol observers always receive original bytes."""
import atexit
import codecs
import os
import sys


COLORS = {
    'SESSION': '36', 'MODEL': '35', 'TOOL': '34', 'EDIT': '32',
    'CHECK': '36', 'APPROVE': '1;33', 'ERROR': '1;31', 'WARN': '33',
    'BUDGET': '2', 'INFO': '2', 'AGENT': '1;32', 'YOU': '1;36',
    'DIFF': '36',
    'PROJECT': '36', 'CONTEXT': '35',
}


def category(line, stderr=False):
    """Classify presentation only, without interpreting model/tool authority."""
    for tag in COLORS:
        if line.startswith(f'[{tag:<7}]'):
            return tag
    if line.startswith('nomo> '):
        return 'YOU'
    if is_prompt(line) or line.startswith(('CONFIRM ', 'Type `yes` to approve:', 'Run this exact command?',
                        'Record abandon?', 'Abandon ')):
        return 'APPROVE'
    if line.startswith(('REFUSED ', 'ERROR ', 'error[', 'READ_PLAN_REJECTION ', 'Cannot ', 'UNRESOLVED ',
                        'Terminal cleanup is unconfirmed', 'Check failed')):
        return 'ERROR'
    if line.startswith(('WARNING ', 'WARN', 'Input cancelled', 'Cancellation ',
                        'Runtime diagnostic', 'Turn stopped', 'Work stopped')):
        return 'WARN'
    if line.startswith(('SESSION', 'SAVED ', 'NEXT ', 'Resume', 'Inspect status:',
                        'Selected latest', 'New session:', 'TIMELINE ', 'CHAT ',
                        'WORK ', 'FOLLOWUP ', 'UNORDERED ')):
        return 'SESSION'
    if line.startswith(('Check ', 'CHECK ', 'Running the ', 'Automatic check', 'NATURAL CHECK')):
        return 'CHECK'
    if line.startswith(('PREVIEW ', 'EDIT ', 'Selected ', 'NATURAL WORK',
                        'POST_EDIT', 'Edit completed')):
        return 'EDIT'
    if line.startswith(('DIFF ', '---', '+++', '@@', '+', '-')):
        return 'DIFF'
    if line.startswith(('TOOL ', 'READ ', 'SEARCH ', 'RESULT ', 'CHILD TOOL', 'CHILD STAGE tool')):
        return 'TOOL'
    if line.startswith('FINAL '):
        return 'AGENT'
    if line.startswith(('LEDGER ', 'BUDGET ', 'RESERV', 'SETTLED ', 'LIMIT ', 'Work allows',
                        'Event recording supports', 'High-input mode', 'A read turn',
                        'This resumed session keeps', 'Model requests have')):
        return 'BUDGET'
    if line.startswith(('MODEL ', 'STAGE ', 'TURN ', 'CHILD ', 'EVENT ', 'PLAN ', 'NATURAL ',
                        'The agent ', 'MiniMax ', 'A busy model')):
        return 'MODEL'
    return 'WARN' if stderr else 'INFO'


def is_prompt(text):
    return (text == 'nomo> ' or text.endswith(('[y/N] ', 'Type `yes` to approve: ',
                                            'Type `yes` to approve:')))


class TerminalBytes:
    def __init__(self, stream):
        self.stream = stream
        self.decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')

    def write_terminal(self, data):
        self.stream.feed(self.decoder.decode(data), external_input=False)
        return len(data)

    write = write_terminal

    def flush(self):
        self.stream.flush()

    def finish(self):
        self.stream.feed(self.decoder.decode(b'', final=True), external_input=False)
        self.decoder.reset()
        self.stream.finish()

    def __getattr__(self, name):
        return getattr(self.stream.target.buffer, name)


class TerminalStream:
    def __init__(self, target, *, color, stderr=False):
        self.target = target
        self.color = color
        self.stderr = stderr
        self.pending = ''
        self.line_start = True
        self.buffer = TerminalBytes(self)

    def emit(self, line, ending):
        if self.line_start and line:
            tag = category(line, self.stderr)
            label = f'[{tag:<7}]'
            if line.startswith(label):
                line = line[len(label):].lstrip(' ')
            if self.color:
                color = COLORS[tag]
                if tag == 'DIFF':
                    color = '31' if line.startswith('-') else '32' if line.startswith('+') else color
                label = f'\x1b[{color}m{label}\x1b[0m'
            self.target.write(label + ' ')
        self.target.write(line + ending)
        self.line_start = bool(ending)

    def feed(self, text, *, external_input):
        self.pending += text
        while '\n' in self.pending:
            line, self.pending = self.pending.split('\n', 1)
            self.emit(line, '\n')
        if self.pending and not self.line_start:
            self.emit(self.pending, '')
            self.pending = ''
        elif is_prompt(self.pending):
            self.emit(self.pending, '')
            self.pending = ''
            # input() echoes through the host terminal, outside this stream.
            # Native prompts echo through the child's pipe instead.
            if external_input:
                self.line_start = True

    def write(self, text):
        self.feed(text, external_input=True)
        return len(text)

    def flush(self):
        self.target.flush()

    def finish(self):
        if self.pending:
            self.emit(self.pending, '')
            self.pending = ''
        self.flush()

    def __getattr__(self, name):
        return getattr(self.target, name)


def install():
    """Decorate TTYs only. NOMO_LOG_FORMAT=raw retains the protocol display."""
    if os.environ.get('NOMO_LOG_FORMAT') == 'raw':
        return
    color = 'NO_COLOR' not in os.environ and os.environ.get('TERM') != 'dumb'
    for name in ('stdout', 'stderr'):
        target = getattr(sys, name)
        if target.isatty():
            stream = TerminalStream(target, color=color, stderr=name == 'stderr')
            setattr(sys, name, stream)
            atexit.register(stream.buffer.finish)
