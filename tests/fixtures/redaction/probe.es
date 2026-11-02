module app.redaction_probe;

import std.io.println;
import std.text.contains;
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.session.redaction.{Policy, policy_error, text, previous, events};

public flow redaction_probe(args: Array<string>) -> i32 ![Console, Error<IOError>, Error<IndexError>] {
    let policy = Policy { format = 1, literals = ["VERY_SECRET_123", "ANOTHER_TOKEN_456"] };
    if policy_error(policy) != "" { abort("valid policy refused"); }
    let input = "a VERY_SECRET_123 b ANOTHER_TOKEN_456 c VERY_SECRET_123";
    let result = match text(input, policy) { Ok(value) => value, Err(_) => { abort("text redaction failed"); } };
    if result.value != "a [REDACTED] b [REDACTED] c [REDACTED]" || result.replacements != 3 { abort("exact replacements changed"); }
    let prior = Previous { task = "Read VERY_SECRET_123", result = "ANOTHER_TOKEN_456", tool = "read",
        outcome = "complete: VERY_SECRET_123", answer = "ANOTHER_TOKEN_456" };
    let clean = match previous("Find VERY_SECRET_123", prior, policy) { Ok(value) => value, Err(_) => { abort("history redaction failed"); } };
    if clean.replacements != 5 || contains(clean.request, "VERY_SECRET_123") || contains(clean.previous.answer, "ANOTHER_TOKEN_456") { abort("history secret retained"); }
    let timeline = [Event { role = "user", kind = "request", name = "", text = "VERY_SECRET_123" },
        Event { role = "tool", kind = "complete", name = "read", text = "ANOTHER_TOKEN_456" }];
    let cleaned = match events(timeline, policy) { Ok(value) => value, Err(_) => { abort("event redaction failed"); } };
    if count(cleaned.events) != 2 || cleaned.events[0].role != "user" || cleaned.events[1].role != "tool" ||
        cleaned.events[0].text != "[REDACTED]" || cleaned.events[1].text != "[REDACTED]" || cleaned.replacements != 2 { abort("event order or redaction changed"); }
    if policy_error(Policy { format = 1, literals = [] }) == "" || policy_error(Policy { format = 1, literals = ["short"] }) == "" ||
        policy_error(Policy { format = 1, literals = ["VERY_SECRET_123", "SECRET_123"] }) == "" { abort("invalid redaction policy accepted"); }
    let meta = [Event { role = "user", kind = "request", name = "VERY_SECRET_123", text = "safe" }];
    match events(meta, policy) { Ok(_) => { abort("sensitive event metadata accepted"); } Err(_) => {} }
    println("PASS bounded exact-match redaction; no automatic secret discovery"); return 0;
}
