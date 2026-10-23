module app.main;

import std.io.{println, read_all};
import std.text.{len, to_string_usize};
import std.collections.len as count;
import std.json.parse;
import std.agent.message.Message;
import nomo.cli_request.{Request, LineCommand, parse_args, parse_line};
import nomo.text.printable;

type Case = { label: string, mode: string, args: Array<string>, raw: string,
    accepted: bool, kind: string, session_id: string, once_supplied: bool,
    once: string, text: string };

public flow args_pure() -> bool {
    return match parse_args(["new"]) { Ok(value) => value.kind == "new", Err(_) => false };
}

public flow line_pure() -> bool {
    return match parse_line("hello") { Ok(value) => value.kind == "prompt", Err(_) => false };
}

flow bounded_diagnostic(value: string) -> bool {
    if len(value) == 0 || len(value) > 128 || !printable(value) { return false; }
    // Exact fixed literals prevent a short printable user-input echo passing.
    return value == "expected bounded new, resume or help arguments" ||
        value == "help must be used alone" || value == "expected new, resume or help" ||
        value == "new forbids a resume selector" ||
        value == "duplicate or conflicting resume selector" || value == "unknown option" ||
        value == "duplicate --once" || value == "missing option value" ||
        value == "session ID must be 1..128 printable ASCII characters" ||
        value == "resume requires --id ID or --latest" || line_diagnostic(value);
}

flow line_diagnostic(value: string) -> bool {
    return value == "input exceeds 1024 characters" ||
        value == "expected printable ASCII single-line input" || value == "empty input" ||
        value == "unsupported command; use /help or /exit in line mode";
}

flow args_case(item: Case) -> unit {
    let actual = parse_args(item.args);
    if actual != parse_args(item.args) { abort("non-deterministic request result"); }
    match actual {
        Ok(value) => {
            if !item.accepted { abort("accepted refused request fixture"); }
            let expected = Request { kind = item.kind, session_id = item.session_id,
                once_supplied = item.once_supplied, once = item.once };
            if value != expected { abort("request changed expected fields"); }
        }
        Err(error) => {
            if item.accepted { abort("refused accepted request fixture"); }
            if !bounded_diagnostic(error) { abort("unbounded request diagnostic"); }
        }
    }
}

flow line_case(item: Case) -> unit {
    let actual = parse_line(item.raw);
    if actual != parse_line(item.raw) { abort("non-deterministic line result"); }
    match actual {
        Ok(value) => {
            if !item.accepted { abort("accepted refused line fixture"); }
            let expected = LineCommand { kind = item.kind, text = item.text };
            if value != expected { abort("line changed expected fields"); }
        }
        Err(error) => {
            if item.accepted { abort("refused accepted line fixture"); }
            if !bounded_diagnostic(error) || !line_diagnostic(error) { abort("non-fixed line diagnostic"); }
        }
    }
}

public flow main(args: Array<string>) -> i32 {
    let parsed = match parse(read_all()) {
        Ok(value) => value, Err(_) => { abort("invalid synthetic JSON fixture"); }
    };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<Case>>> = message.cast<Array<Case>>();
    let fixtures = match conversion {
        Some(value) => value.body, None() => { abort("invalid synthetic fixture shape"); }
    };
    if count(fixtures) == 0 || count(fixtures) > 512 { abort("invalid fixture count"); }
    var ordinal: usize = 0;
    for item in fixtures limit Iterations(512) {
        println("CASE " + to_string_usize(ordinal) + " " + item.label);
        if item.mode == "args" { args_case(item); }
        else if item.mode == "line" { line_case(item); }
        else { abort("unknown synthetic fixture mode"); }
        println("PASS " + to_string_usize(ordinal) + " " + item.label);
        ordinal = ordinal + 1;
    }
    println("PASS CLI001A " + to_string_usize(count(fixtures)));
    return 0;
}
