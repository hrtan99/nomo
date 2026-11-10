module nomo.cli.cli_request;

import nomo.core.large_context.{request_bytes};

import std.collections.len as count;
import std.text.{char_count as len, trim, strip_suffix};
import nomo.core.text.{printable, input_error};
import nomo.session.store_record.valid_id;

// CLI-001A: intents only; these records neither select storage nor authorize work.
public type Request = { kind: string, session_id: string, once_supplied: bool, once: string };
public type LineCommand = { kind: string, text: string };

public flow parse_args(args: Array<string>) -> Result<Request, string> {
    if count(args) == 0 || count(args) > 5 { return Err("expected bounded new, resume or help arguments"); }
    let verb = args[0];
    if verb == "help" || verb == "--help" {
        if count(args) != 1 { return Err("help must be used alone"); }
        return Ok(Request { kind = "help", session_id = "", once_supplied = false, once = "" });
    }
    if verb != "new" && verb != "resume" { return Err("expected new, resume or help"); }
    var session_id = "";
    var selected = false;
    var latest = false;
    var supplied = false;
    var input = "";
    var index: usize = 1;
    while index < count(args) limit Iterations(4) {
        let flag = args[index];
        if flag == "--latest" {
            if verb != "resume" { return Err("new forbids a resume selector"); }
            if selected { return Err("duplicate or conflicting resume selector"); }
            selected = true;
            latest = true;
            index = index + 1;
        } else {
            if flag != "--id" && flag != "--once" { return Err("unknown option"); }
            if flag == "--id" {
                if verb != "resume" { return Err("new forbids a resume selector"); }
                if selected { return Err("duplicate or conflicting resume selector"); }
            } else if supplied { return Err("duplicate --once"); }
            if index + 1 >= count(args) { return Err("missing option value"); }
            // Values are literal: a valid ID or prompt may itself look like a flag.
            let value = args[index + 1];
            if flag == "--id" {
                if !valid_id(value) { return Err("session ID must be 1..128 printable ASCII characters"); }
                session_id = value;
                selected = true;
            } else {
                if len(value) > request_bytes() { return Err("input exceeds 65536 characters"); }
                if !printable(value) { return Err("expected printable ASCII single-line input"); }
                let invalid = input_error(value);
                if invalid != "" { return Err(invalid); }
                input = value;
                supplied = true;
            }
            index = index + 2;
        }
    }
    if verb == "resume" && !selected { return Err("resume requires --id ID or --latest"); }
    var kind = "new";
    if verb == "resume" {
        kind = "resume-id";
        if latest { kind = "resume-latest"; }
    }
    return Ok(Request { kind = kind, session_id = session_id, once_supplied = supplied, once = input });
}

// Raw Console line: the ceiling includes an optional single final LF/CRLF.
// Controls other than that framing cannot disappear silently through trim.
public flow parse_line(raw: string) -> Result<LineCommand, string> {
    if len(raw) > request_bytes() { return Err("input exceeds 65536 characters"); }
    let body = match strip_suffix(raw, "\r\n") { Some(value) => value,
        None() => match strip_suffix(raw, "\n") { Some(value) => value, None() => raw } };
    if !printable(body) { return Err("expected printable ASCII single-line input"); }
    let command = trim(body);
    if command == "/help" { return Ok(LineCommand { kind = "help", text = "" }); }
    if command == "/exit" { return Ok(LineCommand { kind = "exit", text = "" }); }
    let invalid = input_error(command);
    if invalid != "" { return Err(invalid); }
    return Ok(LineCommand { kind = "prompt", text = command });
}
