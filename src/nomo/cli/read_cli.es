module nomo.cli.read_cli;

import std.collections.len as count;
import std.text.{trim, starts_with, strip_suffix};
import std.codec.text.utf8_encode;
import std.bytes.len as bytes_len;
import nomo.core.read_text.safe;
import nomo.cli.cli_request.{Request, LineCommand};

// Only the non-durable read-only entry uses this parser. Legacy session and
// edit arguments retain their existing parser and wire contract.
flow prompt_error(value: string) -> string {
    if bytes_len(utf8_encode(value)) > 128 { return "question exceeds 128 UTF-8 bytes"; }
    if trim(value) == "" || !safe(value, 128) { return "question requires nonblank safe single-line UTF-8"; }
    if starts_with(trim(value), "/") { return "unsupported command; use /help or /exit"; }
    return "";
}

public flow parse_args(args: Array<string>) -> Result<Request, string> {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Request { kind = "help", session_id = "", once_supplied = false, once = "" });
    }
    if count(args) != 3 || args[0] != "new" || args[1] != "--once" { return Err("expected new --once TEXT"); }
    let invalid = prompt_error(args[2]); if invalid != "" { return Err(invalid); }
    return Ok(Request { kind = "new", session_id = "", once_supplied = true, once = args[2] });
}

public flow parse_line(raw: string) -> Result<LineCommand, string> {
    if bytes_len(utf8_encode(raw)) > 130 { return Err("input exceeds 128 UTF-8 bytes plus LF/CRLF"); }
    let body = match strip_suffix(raw, "\r\n") { Some(value) => value,
        None() => match strip_suffix(raw, "\n") { Some(value) => value, None() => raw } };
    if !safe(body, 128) { return Err("unsafe terminal character"); }
    let command = trim(body);
    if command == "/help" { return Ok(LineCommand { kind = "help", text = "" }); }
    if command == "/exit" { return Ok(LineCommand { kind = "exit", text = "" }); }
    let invalid = prompt_error(command); if invalid != "" { return Err(invalid); }
    return Ok(LineCommand { kind = "prompt", text = command });
}
