"""Synthetic expected values, not a Python implementation of either parser."""


def request(label, args, kind=None, session_id="", once=None):
    return {"label": label, "mode": "args", "args": args, "raw": "",
            "accepted": kind is not None, "kind": kind or "", "session_id": session_id,
            "once_supplied": once is not None, "once": once or "", "text": ""}


def line(label, raw, kind=None, text=""):
    return {"label": label, "mode": "line", "args": [], "raw": raw,
            "accepted": kind is not None, "kind": kind or "", "session_id": "",
            "once_supplied": False, "once": "", "text": text}


def cases():
    result = [
        request("new-interactive", ["new"], "new"),
        request("new-once", ["new", "--once", "hello"], "new", once="hello"),
        request("new-once-raw-preserved", ["new", "--once", "  hello  "], "new", once="  hello  "),
        request("new-once-option-looking", ["new", "--once", "--help"], "new", once="--help"),
        request("new-once-once-looking", ["new", "--once", "--once"], "new", once="--once"),
        request("new-once-command-looking", ["new", "--once", "resume"], "new", once="resume"),
        request("resume-id", ["resume", "--id", "session"], "resume-id", session_id="session"),
        request("resume-id-once-after", ["resume", "--id", "s", "--once", "p"], "resume-id", "s", "p"),
        request("resume-id-once-before", ["resume", "--once", "p", "--id", "s"], "resume-id", "s", "p"),
        request("resume-latest", ["resume", "--latest"], "resume-latest"),
        request("resume-latest-once-after", ["resume", "--latest", "--once", "p"], "resume-latest", once="p"),
        request("resume-latest-once-before", ["resume", "--once", "p", "--latest"], "resume-latest", once="p"),
        request("help-word", ["help"], "help"),
        request("help-option", ["--help"], "help"),
    ]
    invalid_arguments = {
        "no-command": [], "empty-command": [""], "unknown-command": ["other"],
        "new-command-not-first": ["--once", "p", "new"],
        "resume-command-not-first": ["--latest", "resume"],
        "new-case-sensitive": ["New"], "help-short-unsupported": ["-h"],
        "command-no-trimming": [" new "], "command-repeat": ["new", "new"],
        "new-unknown": ["new", "--unknown"], "new-positional": ["new", "p"],
        "new-unknown-echo-marker": ["new", "--CLI001A-ARG-ECHO-MARKER"],
        "new-missing-once": ["new", "--once"],
        "new-duplicate-once": ["new", "--once", "a", "--once", "b"],
        "new-id-forbidden": ["new", "--id", "s"], "new-latest-forbidden": ["new", "--latest"],
        "new-help-forbidden": ["new", "--help"],
        "help-once-forbidden": ["help", "--once", "p"],
        "help-id-forbidden": ["help", "--id", "s"],
        "help-new-forbidden": ["help", "new"],
        "help-repeat-forbidden": ["help", "help"],
        "option-help-once-forbidden": ["--help", "--once", "p"],
        "option-help-resume-forbidden": ["--help", "resume", "--latest"],
        "resume-help-forbidden": ["resume", "--help"],
        "resume-no-selection": ["resume"],
        "resume-once-no-selection": ["resume", "--once", "p"],
        "resume-missing-id": ["resume", "--id"],
        "resume-empty-id": ["resume", "--id", ""],
        "resume-missing-once": ["resume", "--latest", "--once"],
        "resume-duplicate-id": ["resume", "--id", "a", "--id", "b"],
        "resume-duplicate-latest": ["resume", "--latest", "--latest"],
        "resume-id-latest-conflict": ["resume", "--id", "s", "--latest"],
        "resume-latest-id-conflict": ["resume", "--latest", "--id", "s"],
        "resume-duplicate-once": ["resume", "--latest", "--once", "a", "--once", "b"],
        "resume-unknown": ["resume", "--latest", "--unknown"],
        "resume-positional": ["resume", "--latest", "p"],
        "resume-new-forbidden": ["resume", "--latest", "new"],
        "new-too-many-tokens": ["new", "--once", "p", "--once", "q", "--once", "r"],
        "resume-too-many-tokens": ["resume", "--id", "s", "--once", "p", "--latest", "--unknown"],
    }
    result += [request(label, args) for label, args in invalid_arguments.items()]
    identifiers = {
        "one-character": "x", "one-space": " ", "spaces-128": " " * 128,
        "raw-space-preserved": "  session  ", "length-127": "x" * 127,
        "length-128": "x" * 128, "path-looking": "../a/b?name=one:two",
        "option-latest": "--latest", "option-id": "--id", "option-once": "--once",
        "option-help": "--help",
        "punctuation": ''.join(chr(value) for value in range(32, 127)),
    }
    result += [request("id-" + label, ["resume", "--id", value], "resume-id", value)
               for label, value in identifiers.items()]
    result += [request("id-reject-" + label, ["resume", "--id", value])
               for label, value in {"length-129": "x" * 129, "non-ascii": "é",
                                    "unicode": "世界", "delete": "s\x7f"}.items()]
    for code in range(32):
        result.append(request("id-control-" + str(code), ["resume", "--id", "s" + chr(code)]))
    result += [
        request("once-length-1024", ["new", "--once", "x" * 1024], "new", once="x" * 1024),
        request("once-raw-bound-1024", ["new", "--once", " " * 1023 + "x"], "new", once=" " * 1023 + "x"),
        request("once-length-1025", ["new", "--once", "x" * 1025]),
        request("once-raw-bound-1025", ["new", "--once", " " * 1024 + "x"]),
    ]
    for label, value in {"empty": "", "spaces": "   ", "slash-help": "/help",
                         "slash-exit": " /exit ", "slash-other": "/other",
                         "non-ascii": "é", "delete": "x\x7f"}.items():
        result.append(request("once-reject-" + label, ["new", "--once", value]))
    for code in range(32):
        # Includes leading/trailing controls: one-shot argv has no line terminator.
        result.append(request("once-control-" + str(code), ["new", "--once", chr(code) + "x"]))
    result += [
        line("prompt-plain", "hello", "prompt", "hello"),
        line("prompt-spaces", "  hello  ", "prompt", "hello"),
        line("prompt-option-looking", "--help", "prompt", "--help"),
        line("prompt-resume-word", "resume", "prompt", "resume"),
        line("prompt-printable-punctuation", "Hello: !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
             "prompt", "Hello: !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"),
        line("line-help", "/help", "help"), line("line-help-spaces", " /help ", "help"),
        line("line-exit", "/exit", "exit"), line("line-exit-spaces", " /exit ", "exit"),
        line("prompt-length-1024", "x" * 1024, "prompt", "x" * 1024),
        line("prompt-length-1025", "x" * 1025),
        line("prompt-raw-bound-1024", " " * 1023 + "x", "prompt", "x"),
        line("prompt-raw-bound-1025", " " * 1024 + "x"),
        line("help-raw-bound-1024", " " * 1019 + "/help", "help"),
        line("help-raw-bound-1025", " " * 1020 + "/help"),
    ]
    for label, value in {"empty": "", "spaces": "   ", "unknown-slash": "/other",
                         "help-case": "/Help", "help-suffix": "/help extra",
                         "double-slash": "//help", "exit-suffix": "/exit now",
                         "slash-echo-marker": "/CLI001A-LINE-ECHO-MARKER",
                         "slash-alone": "/", "slash-after-spaces": " /other ",
                         "non-ascii": "é", "unicode": "世界", "delete": "x\x7f"}.items():
        result.append(line("line-reject-" + label, value))
    for code in range(32):
        result.append(line("line-embedded-control-" + str(code), "a" + chr(code) + "b"))
    result += [
        # Final TL contract preserves the accepted raw Console line convention:
        # one final LF/CRLF is optional and counts toward the raw 1024 ceiling.
        line("prompt-lf", "hello\n", "prompt", "hello"),
        line("prompt-crlf", "hello\r\n", "prompt", "hello"),
        line("prompt-spaces-lf", "  hello  \n", "prompt", "hello"),
        line("line-help-lf", " /help \n", "help"),
        line("line-help-crlf", " /help \r\n", "help"),
        line("line-exit-lf", " /exit \n", "exit"),
        line("line-exit-crlf", " /exit \r\n", "exit"),
        line("line-lf-raw-1024", "x" * 1023 + "\n", "prompt", "x" * 1023),
        line("line-lf-raw-1025", "x" * 1024 + "\n"),
        line("line-crlf-raw-1024", "x" * 1022 + "\r\n", "prompt", "x" * 1022),
        line("line-crlf-raw-1025", "x" * 1023 + "\r\n"),
    ]
    for label, value in {"lf-only": "\n", "crlf-only": "\r\n", "spaces-lf": "  \n",
                         "bare-cr": "x\r", "leading-lf": "\nx", "double-lf": "x\n\n",
                         "double-crlf": "x\r\n\r\n", "lf-then-space": "x\n ",
                         "crlf-then-space": "x\r\n ", "tab-leading": "\tx",
                         "tab-trailing": "x\t", "tab-before-lf": "x\t\n",
                         "tab-around-help": "\t/help\n", "help-double-lf": "/help\n\n",
                         "exit-bare-cr": "/exit\r"}.items():
        result.append(line("line-reject-" + label, value))
    return result
