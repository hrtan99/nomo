module app.main;

import std.io.println;
import nomo.domain.text.safe;
import nomo.domain.text.data_safe;
import nomo.domain.text.within;
import nomo.domain.text.hex_digest;
import nomo.domain.harness.loop.Context;
import nomo.domain.harness.loop.candidate_error;
import nomo.domain.context.EventPolicy;
import nomo.domain.context.select;
import nomo.domain.wire.json;
import nomo.domain.wire.digest;
import nomo.domain.wire.ascii_json_with;
import nomo.domain.conversation.Event;
import nomo.domain.conversation.State;
import nomo.adapters.filesystem.workspace.{search_files, search_wide};
import nomo.adapters.cli.console.ConsoleConversationPicker;
import nomo.application.conversation.ports.ConversationPicker;
import nomo.adapters.model.continuation.target;
import nomo.domain.harness.delegation.next;
import nomo.domain.harness.work.Evidence;
import nomo.domain.harness.loop.ReadLedger;
import nomo.domain.editing.{render, prepare_original, bind};
import nomo.domain.sessions.work.{partial, admit};
import nomo.domain.sessions.state.{snapshot, validate, caps, Request as SessionRequest};
import nomo.domain.sessions.event_codec.{Policy, encode_prefix, event_text_codec_decode, probe_excerpt};
import nomo.domain.wire.json_scalar_width;
import nomo.domain.conversation.SavedSession;
import nomo.domain.conversation.ConversationLedger;
import nomo.application.resources.ReadOnlyRoot;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.io.IOError;
import std.text.{char_count, chars, contains, count, ends_with, from_char, starts_with};

flow check(label: string, value: bool) -> unit {
    if !value {
        abort(label);
    }
    println("PASS " + label);
}

public flow run(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let large = __LARGE_TEXT__;
    check("1 MiB text", within(large, 1048576) && safe(large, 1048576));
    check("Unicode text", safe("中文😀", 10));
    check("multiline data", data_safe("中文\n\r\t😀", 13));
    let hash = match digest("hello") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    check(
        "standard SHA and byte mapping",
        hash == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" && hex_digest(hash)
    );
    let encoded = match json(["前😀"]) {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    check("Unicode JSON builder", encoded == "[\"\\u524d\\ud83d\\ude00\"]");
    let display = match ascii_json_with("\"前😀\"", 32, 32, "encoded", "display") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    check("display builder", display == "\"\\u524d\\ud83d\\ude00\"");
    check("standard unique paths", candidate_error(["a.txt", "b.txt"]) == "");
    let context = Context {
        history = [Event {
            role = "user",
            kind = "input",
            name = "",
            text = "read a.txt"
        }],
        allowed = ["a.txt"],
        final_only = false
    };
    let result = match select(context, [EventPolicy.Task], 1048576) {
        Ok(value) => value,
        Err(_) => abort("selection"),
    };
    check("ordered selection", result.context == context && result.selected == [0] && result.omitted == []);
    return 0;
}

public flow unicode(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let scalars: Array<u32> = [
        0,
        1,
        8,
        9,
        10,
        12,
        13,
        34,
        92,
        127,
        128,
        159,
        8206,
        21069,
        65535,
        128512,
        1114111
    ];
    let expected: Array<string> = __SCALAR_JSON__;
    var exact = true;
    for (index, code) in scalars.iter().enumerate() {
        let character = char.from_u32(code).unwrap();
        let value = match json([from_char(character)]) {
            Ok(item) => item,
            Err(error) => abort(error)
        };
        let canonical = if code == 127 {
            "[\"" + from_char(character) + "\"]"
        } else {
            expected[index]
        };
        exact = exact && value == canonical && json_scalar_width(character) == char_count(value) - 4;
    }
    check("canonical scalar bytes and preview widths", exact);
    let preview = match render("前😀\t\"\n", "后😀\t\"\n") {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    check(
        "mixed Unicode preview",
        contains(preview, "- \\u524d\\ud83d\\ude00\\u0009\\\"\n")
            && contains(preview, "+ \\u540e\\ud83d\\ude00\\u0009\\\"\n")
    );
    let policy = Policy {
        format = 1,
        literals = ["SYNTHETIC_SECRET"]
    };
    let prefix = match encode_prefix("before SYNTHETIC_SECRET after", true, policy) {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    let redacted = match event_text_codec_decode(prefix.value, policy) {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    check(
        "redacted UTF-8 boundary excerpts",
        prefix.truncated && redacted == "before [REDACTED] after"
            && probe_excerpt(__EXCERPT_INPUT__) == __EXCERPT_EXPECTED__
    );
    return 0;
}

public flow search(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Fs.read<ReadOnlyRoot>,
    Error<FileError>
] {
    let search = search_files(["a.txt", "鹈鹕.txt"], "needle");
    check(
        "lazy search LF CRLF Unicode and final empty line",
        search.status == "complete" && search.text == "a.txt:1\na.txt:3\n鹈鹕.txt:2\n"
            && search.scanned == __SEARCH_BYTES__
    );
    let cap = search_wide(["hits.txt"], "n");
    check(
        "search builder aggregation",
        cap.status == "complete" && cap.scanned == 256 && count(cap.text, "\n") == 128
            && starts_with(cap.text, "hits.txt:1\n") && ends_with(cap.text, "hits.txt:128\n")
    );
    return 0;
}

public flow references(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let events = [
        Event {
            role = "user",
            kind = "input",
            name = "",
            text = "hello"
        },
        Event {
            role = "model",
            kind = "request",
            name = "echo",
            text = "hello"
        },
        Event {
            role = "tool",
            kind = "complete",
            name = "echo",
            text = "hello"
        },
        Event {
            role = "assistant",
            kind = "final",
            name = "",
            text = "done"
        }
    ];
    let state = State {
        events,
        characters = 27,
        spent = 2,
        stopped = false
    };
    let saved = match snapshot(state, "session", "binding", 3, 16) {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    let projected = match validate(
        saved,
        SessionRequest {
            mode = "stub",
            session_id = "session",
            binding = "binding",
            caps = caps(3, 16)
        }
    ) {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    check(
        "indexed operation references",
        projected.history == state && projected.disposition == "validated" && projected.operations.len() == 1
    );
    let context = Context {
        history = [Event {
            role = "user",
            kind = "input",
            name = "",
            text = "read a.txt"
        }],
        allowed = ["a.txt"],
        final_only = false
    };
    let optional_events = context {
        history = context.history.extend(
            [
                Event {
                    role = "assistant",
                    kind = "note",
                    name = "",
                    text = __OPTIONAL_LARGE__
                },
                Event {
                    role = "assistant",
                    kind = "note",
                    name = "",
                    text = "small"
                }
            ]
        )
    };
    let selected = match select(
        optional_events,
        [EventPolicy.Task, EventPolicy.Optional, EventPolicy.Optional],
        512
    ) {
        Ok(value) => value,
        Err(_) => abort("greedy selection")
    };
    check(
        "ordered set membership keeps later fitting event",
        selected.selected == [0, 2] && selected.omitted == [1]
            && selected.context.history == [optional_events.history[0], optional_events.history[2]]
    );
    return 0;
}

public flow recall(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let events = [
        Event {
            role = "user",
            kind = "input",
            name = "",
            text = "hello"
        },
        Event {
            role = "model",
            kind = "request",
            name = "echo",
            text = "hello"
        },
        Event {
            role = "tool",
            kind = "complete",
            name = "echo",
            text = "hello"
        },
        Event {
            role = "assistant",
            kind = "final",
            name = "",
            text = "done"
        }
    ];
    let remembered = next("recall", events, false, "");
    check("last completed recall", remembered.kind == "final" && remembered.text == "remembered: hello");
    return 0;
}

public flow path_selection(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    check("standard path selection", target("EDIT note.txt", ["a.txt", "note.txt"]) == Some("note.txt"));
    return 0;
}

public flow picker(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let first = SavedSession {
        id = "one",
        workspace = "/fixture",
        title = "First",
        next_event = 0,
        first_user = -1,
        summary_event = -1,
        summary_through = -1,
        pending = "",
        ledger = ConversationLedger {
            turns = 0,
            compactions = 0,
            tools = 0,
            generation_allowance = 0,
            context_bytes = 0
        }
    };
    let sessions = [first, first {
        id = "two",
        title = "Second"
    }];
    let picker = ConsoleConversationPicker {};
    check("indexed conversation choice", picker.choose(sessions) == Some("two"));
    return 0;
}

public flow admission(args: Array<string>) -> i32 ![
    Console,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let prepared = match prepare_original("note.txt", "old", "old", "new") {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    let binding = match bind("edit-op", "owned", "note.txt", prepared) {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    let evidence = Evidence {
        request = "update target from context",
        task = "Read context.txt",
        operation = "read",
        files = ["context.txt"],
        literal = "",
        outcome = "complete: blue",
        result = "Seen: complete: blue",
        summary = "Use the context result",
        allowed = ["context.txt"],
        ledger = ReadLedger {
            steps = 7,
            calls = 4,
            tokens = 8192,
            tools = 1,
            scan = 4096
        }
    };
    let row = match partial(binding, evidence, "replace selected text", prepared) {
        Ok(value) => value,
        Err(error) => abort(error)
    };
    check(
        "pure repeated admission sentinel",
        match admit(row) {
            Ok(value) => value,
            Err(error) => abort(error)
        }
    );
    return 0;
}
