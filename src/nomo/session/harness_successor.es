module nomo.session.harness_successor;

import nomo.core.json.{encode as encode_json, string_fields};

import std.text.{len, trim, to_string_i32, to_string_usize};
import std.collections.len as count;


import nomo.core.text.printable;
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.Session;
import nomo.model.model_tool_contract.Context as ChildContext;
import nomo.model.model_tool_contract.context_error as child_context_error;
import nomo.harness.harness_model_contract.{bounded, decode_plan};
import nomo.harness.harness_tool_contract.{Ledger, same};
import nomo.harness.harness_tool_chat_contract.{Previous, Context, Invocation, TurnResult, prior_error, turn_error, context_error, inspect_turn};
import nomo.session.harness_checkpoint.{Identity, Checkpoint, identity_error, read_ledger, framed, records_error, fields_error};
import nomo.session.harness_checkpoint.validate as validate_first;
import nomo.session.harness_checkpoint.encode as encode_first;
import nomo.session.harness_checkpoint.decode as decode_first;

// Independent second-boundary format. The original v1 first boundary stays intact.
public type Successor = { format: i32, identity: Identity, predecessor: Checkpoint, predecessor_version: string,
    request: string, task: string, result: string, tool: string, outcome: string, answer: string,
    records: Array<Event>, usage: Ledger, maximum: Ledger, admitted: i32, lifecycle: string, resolved: bool };

flow previous(saved: Checkpoint) -> Previous {
    return Previous { task = saved.task, result = saved.result, tool = saved.tool, outcome = saved.outcome, answer = saved.answer };
}

public flow restore(saved: Checkpoint) -> Result<Invocation, string> {
    match validate_first(saved, saved.identity) { Ok(_) => {} Err(error) => { return Err(error); } }
    let invocation = Invocation { usage = saved.usage, maximum = saved.maximum, admitted = saved.admitted, prior = previous(saved) };
    let invalid = turn_error(invocation); if invalid != "" { return Err(invalid); }
    return Ok(invocation);
}

public flow validate(saved: Successor, requested: Identity, predecessor_identity: Identity) -> Result<Successor, string> {
    let invalid = identity_error(requested); if invalid != "" { return Err(invalid); }
    if saved.identity != requested || saved.identity.id == predecessor_identity.id ||
        saved.identity.workspace != predecessor_identity.workspace || saved.identity.allowed != predecessor_identity.allowed {
        return Err("successor identity or predecessor binding mismatch");
    }
    match validate_first(saved.predecessor, predecessor_identity) { Ok(_) => {} Err(error) => { return Err(error); } }
    let restored = match restore(saved.predecessor) { Ok(value) => value, Err(error) => { return Err(error); } };
    if len(saved.predecessor_version) == 0 || len(saved.predecessor_version) > 1024 ||
        !printable(saved.predecessor_version) || trim(saved.predecessor_version) == "" { return Err("invalid predecessor version"); }
    if saved.format != 1 || saved.admitted != 2 || saved.lifecycle != "completed" || !saved.resolved {
        return Err("successor is not a completed settled second turn");
    }
    if !bounded(saved.request, 128) || !bounded(saved.task, 128) { return Err("invalid successor request or task"); }
    let selected = Previous { task = saved.task, result = saved.result, tool = saved.tool, outcome = saved.outcome, answer = saved.answer };
    let invalid_prior = prior_error(selected); if invalid_prior != "" { return Err(invalid_prior); }
    var tools: i32 = 0; var child_count: usize = 9; var record_count: usize = 14;
    if saved.tool != "" { tools = 1; child_count = 12; record_count = 18; }
    let before = restored.usage;
    let exact = Ledger { steps = before.steps + 5 + tools * 2, calls = before.calls + 3 + tools,
        tokens = before.tokens + (3 + tools) * 2048, tools = before.tools + tools, scan = before.scan + tools * 4096 };
    if saved.usage != exact || saved.maximum != restored.maximum { return Err("successor cumulative usage or limits mismatch"); }
    let records = saved.records;
    if count(records) != record_count { return Err("invalid successor record count"); }
    let record_error = records_error(records, 8192, "successor");
    if record_error != "" { return Err(record_error); }
    if !same(records[0], "user", "request", "", saved.request) || !same(records[1], "main", "plan", "", records[1].text) ||
        !same(records[2], "main", "delegate", "child-1", saved.task) { return Err("invalid successor planning records"); }
    let task = match decode_plan(records[1].text) { Ok(value) => value, Err(error) => { return Err(error); } };
    if task != saved.task { return Err("successor plan and delegated task disagree"); }
    var events: Array<Event> = []; var child_characters: usize = 0; var index: usize = 0;
    var first_input: Array<Event> = []; var final_input: Array<Event> = [];
    while index < child_count limit Iterations(12) {
        let event = records[3 + index]; events = events.push(event);
        if index < 7 { first_input = first_input.push(event); }
        if index < 10 { final_input = final_input.push(event); }
        child_characters = child_characters + len(event.name) + len(event.text); index = index + 1;
    }
    let child_tools: usize = if tools == 1 { 1 } else { 0 };
    let child_calls: usize = if tools == 1 { 2 } else { 1 };
    let child = Session { history = State { events = events, characters = child_characters, spent = 1 + tools * 2, stopped = false },
        calls = child_calls, tokens = child_calls * 2048, tools = child_tools, scan = child_tools * 4096 };
    let observed = match inspect_turn(child, 0, saved.request, saved.task, saved.identity.allowed, restored.prior) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if observed.result != saved.result || observed.tool != saved.tool || observed.outcome != saved.outcome {
        return Err("successor child records and selected result disagree");
    }
    let consumed = 3 + child_count;
    if !same(records[consumed], "main", "consume", "child-1", saved.result) ||
        !same(records[record_count - 1], "main", "answer", "", saved.answer) { return Err("invalid successor consumption records"); }
    if tools == 1 && !same(records[consumed + 1], "main", "tool", saved.tool, saved.outcome) {
        return Err("successor completed tool record mismatch");
    }
    let plan = Context { phase = "plan", request = saved.request, task = "", result = "", tool = "", outcome = "",
        allowed = saved.identity.allowed, prior = restored.prior };
    let aggregate = Context { phase = "aggregate", request = saved.request, task = saved.task, result = saved.result,
        tool = saved.tool, outcome = saved.outcome, allowed = saved.identity.allowed, prior = restored.prior };
    let first = ChildContext { history = first_input, allowed = saved.identity.allowed, final_only = false };
    let final = ChildContext { history = final_input, allowed = saved.identity.allowed, final_only = true };
    let plan_error = context_error(plan); if plan_error != "" { return Err(plan_error); }
    let aggregate_error = context_error(aggregate); if aggregate_error != "" { return Err(aggregate_error); }
    let first_error = child_context_error(first); if first_error != "" { return Err(first_error); }
    if tools == 1 { let final_error = child_context_error(final); if final_error != "" { return Err(final_error); } }
    return Ok(saved);
}

public flow from_turn(identity: Identity, predecessor: Checkpoint, predecessor_version: string, turn: TurnResult) -> Result<Successor, string> {
    if turn.status != 0 || !turn.resolved || turn.state.admitted != 2 { return Err("only a successful resolved second turn can be saved"); }
    let completed = match turn.completed { Some(value) => value, None() => { return Err("completed successor records missing"); } };
    let selected = Previous { task = completed.task, result = completed.result, tool = completed.tool,
        outcome = completed.outcome, answer = completed.answer };
    if turn.state.prior != selected { return Err("completed successor and selected prior disagree"); }
    let saved = Successor { format = 1, identity = identity, predecessor = predecessor, predecessor_version = predecessor_version,
        request = completed.request, task = completed.task, result = completed.result, tool = completed.tool, outcome = completed.outcome,
        answer = completed.answer, records = completed.records, usage = turn.state.usage, maximum = turn.state.maximum,
        admitted = 2, lifecycle = "completed", resolved = true };
    return validate(saved, identity, predecessor.identity);
}

// The nested first checkpoint is data in one string, never a widened v1 cast.


public flow encode(saved: Successor) -> Result<string, string> {
    match validate(saved, saved.identity, saved.predecessor.identity) { Err(error) => { return Err(error); } Ok(_) => {} }
    let predecessor = match encode_first(saved.predecessor) { Ok(value) => value, Err(error) => { return Err(error); } };
    var second = ""; if count(saved.identity.allowed) == 2 { second = saved.identity.allowed[1]; }
    var fields = ["nomo-harness-successor-v1", saved.identity.id, saved.identity.workspace, saved.identity.allowed[0], second,
        predecessor, saved.predecessor_version, saved.request, saved.task, saved.result, saved.tool, saved.outcome, saved.answer,
        to_string_i32(saved.usage.steps), to_string_i32(saved.usage.calls), to_string_i32(saved.usage.tokens),
        to_string_i32(saved.usage.tools), to_string_i32(saved.usage.scan), to_string_i32(saved.maximum.steps),
        to_string_i32(saved.maximum.calls), to_string_i32(saved.maximum.tokens), to_string_i32(saved.maximum.tools),
        to_string_i32(saved.maximum.scan), "2", "completed", "true", to_string_usize(count(saved.records))];
    for event in saved.records limit Iterations(18) {
        fields = fields.push(event.role); fields = fields.push(event.kind); fields = fields.push(event.name); fields = fields.push(event.text);
    }
    let invalid = fields_error(fields, true); if invalid != "" { return Err(invalid); }
    let encoded = match encode_json(fields, "successor encoding conversion refused", "successor JSON encoding refused") { Ok(value) => value, Err(error) => { return Err(error); } };
    if !framed(encoded, true) { return Err("successor encoded bounds exceeded"); }
    return Ok(encoded);
}

public flow decode(raw: string) -> Result<Successor, string> {
    if !framed(raw, true) { return Err("successor encoded shape or bounds invalid"); }
    let fields = match string_fields(raw, "invalid successor JSON", "successor fields must be strings") { Ok(value) => value, Err(error) => { return Err(error); } };
    let invalid = fields_error(fields, true); if invalid != "" { return Err(invalid); }
    if count(fields) != 83 && count(fields) != 99 { return Err("invalid successor field count"); }
    if fields[0] != "nomo-harness-successor-v1" { return Err("unsupported successor format"); }
    if fields[23] != "2" || fields[24] != "completed" || fields[25] != "true" { return Err("successor is not completed and settled"); }
    var record_count: usize = 14; if count(fields) == 99 { record_count = 18; }
    if fields[26] != to_string_usize(record_count) { return Err("successor record count disagrees with framing"); }
    var allowed = [fields[3]]; if fields[4] != "" { allowed = allowed.push(fields[4]); }
    let identity = Identity { id = fields[1], workspace = fields[2], allowed = allowed };
    let predecessor = match decode_first(fields[5]) { Ok(value) => value, Err(error) => { return Err(error); } };
    let usage = match read_ledger(fields, 13, "successor") { Ok(value) => value, Err(error) => { return Err(error); } };
    let maximum = match read_ledger(fields, 18, "successor") { Ok(value) => value, Err(error) => { return Err(error); } };
    var records: Array<Event> = []; var index: usize = 0;
    while index < record_count limit Iterations(18) {
        let offset = 27 + index * 4;
        records = records.push(Event { role = fields[offset], kind = fields[offset + 1], name = fields[offset + 2], text = fields[offset + 3] });
        index = index + 1;
    }
    let saved = Successor { format = 1, identity = identity, predecessor = predecessor, predecessor_version = fields[6],
        request = fields[7], task = fields[8], result = fields[9], tool = fields[10], outcome = fields[11], answer = fields[12],
        records = records, usage = usage, maximum = maximum, admitted = 2, lifecycle = "completed", resolved = true };
    return validate(saved, identity, predecessor.identity);
}
