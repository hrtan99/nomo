module app.contract_probe;

import std.io.println;
import std.text.{char_count as len, split};
import std.bytes.len as byte_count;
import std.codec.text.{utf8_encode, utf8_decode, Strict};
import std.json.parse;
import std.agent.message.Message;
import nomo.tools.path_policy.valid_path;
import nomo.tools.edit_proposal.{Request, Proposal, propose, validate};

type Check = { label: string, mode: string, request: Request, expected: Proposal, error: string };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
// Decode an independent JSON U+0000 escape, rather than trusting both supplied
// request and expected source literals to share the same NUL representation.
flow encoded_nul(value: string) -> bool {
    let json = match parse("\"" + slash() + "u0000\"") { Ok(item) => item, Err(_) => { return false; } };
    let message = Message.new(json);
    let converted: Option<Message<string>> = message.cast<string>();
    let decoded = match converted { Some(item) => item.body, None() => { return false; } };
    let roundtrip = match utf8_decode(utf8_encode(decoded), Strict) { Ok(item) => item, Err(_) => { return false; } };
    return len(value) == 1 && byte_count(utf8_encode(value)) == 1 && value == decoded && value == roundtrip;
}
flow evaluate(item: Check) -> bool {
    if item.mode == "encoding" { return encoded_nul(item.request.original); }
    if item.mode == "path" { return valid_path(item.request.path) == (item.error == ""); }
    let actual = if item.mode == "validate" { validate(item.request, item.expected) } else { propose(item.request) };
    return match actual {
        Ok(value) => item.error == "" && value == item.expected,
        Err(error) => item.error != "" && error == item.error
    };
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !evaluate(item) { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !evaluate(item) { println("FAIL " + item.label); abort("edit proposal contract check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
