module nomo.session.redaction;

import std.text.{contains, count as match_count, replace, len as byte_len};
import std.collections.len as count;
import nomo.core.read_text.safe;
import nomo.core.conversation.Event;
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.harness.read_tool_chat_contract.prior_error;
import nomo.model.read_protocol.question_error;
import nomo.core.large_context.event_bytes;

// The caller must provide known sensitive literals through a trusted private
// boundary. This is exact-match redaction only, not detection of all secrets.
public type Policy = { format: i32, literals: Array<string> };
public type Text = { value: string, replacements: usize };
public type PreviousData = { request: string, previous: Previous, replacements: usize };
public type Events = { events: Array<Event>, replacements: usize };

public flow policy_error(policy: Policy) -> string {
    if policy.format != 1 || count(policy.literals) == 0 || count(policy.literals) > 8 { return "invalid redaction policy"; }
    var i: usize = 0;
    for literal in policy.literals limit Iterations(8) {
        let bytes = byte_len(literal);
        if bytes < 8 || bytes > 256 || !safe(literal, 256) { return "invalid redaction literal"; }
        var j: usize = 0;
        for other in policy.literals limit Iterations(8) {
            if i != j && (contains(literal, other) || contains(other, literal)) { return "overlapping redaction literals"; }
            j = j + 1;
        }
        i = i + 1;
    }
    return "";
}

public flow text(value: string, policy: Policy) -> Result<Text, string> {
    let policy_problem = policy_error(policy); if policy_problem != "" { return Err(policy_problem); }
    if byte_len(value) > event_bytes() { return Err("redaction input exceeds bound"); }
    var output = value; var replacements: usize = 0;
    for literal in policy.literals limit Iterations(8) {
        let matches = match_count(output, literal);
        if matches > 0 { replacements = replacements + matches; output = replace(output, literal, "[REDACTED]"); }
        if byte_len(output) > event_bytes() { return Err("redaction output exceeds bound"); }
    }
    for literal in policy.literals limit Iterations(8) {
        if contains(output, literal) { return Err("redaction result still contains sensitive literal"); }
    }
    return Ok(Text { value = output, replacements = replacements });
}

public flow previous(request: string, prior: Previous, policy: Policy) -> Result<PreviousData, string> {
    let req = match text(request, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let task = match text(prior.task, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let result = match text(prior.result, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let tool = match text(prior.tool, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let outcome = match text(prior.outcome, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let answer = match text(prior.answer, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let projected = Previous { task = task.value, result = result.value, tool = tool.value, outcome = outcome.value, answer = answer.value };
    if question_error(req.value) != "" || prior_error(projected) != "" { return Err("redacted history violates its bounds"); }
    return Ok(PreviousData { request = req.value, previous = projected,
        replacements = req.replacements + task.replacements + result.replacements + tool.replacements + outcome.replacements + answer.replacements });
}

public flow events(value: Array<Event>, policy: Policy) -> Result<Events, string> {
    let problem = policy_error(policy); if problem != "" { return Err(problem); }
    if count(value) > 24 { return Err("too many historical events"); }
    var output: Array<Event> = []; var replacements: usize = 0;
    for event in value limit Iterations(24) {
        if !safe(event.role, 128) || !safe(event.kind, 128) || !safe(event.name, 128) { return Err("invalid historical event metadata"); }
        for literal in policy.literals limit Iterations(8) {
            if contains(event.role, literal) || contains(event.kind, literal) || contains(event.name, literal) { return Err("sensitive literal in event metadata"); }
        }
        let clean = match text(event.text, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
        if !safe(clean.value, 512) { return Err("redacted event text violates bounds"); }
        output = output.push(Event { role = event.role, kind = event.kind, name = event.name, text = clean.value });
        replacements = replacements + clean.replacements;
    }
    return Ok(Events { events = output, replacements = replacements });
}
