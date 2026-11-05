module nomo.session.harness_checkpoint;

import nomo.core.json.{encode as encode_json, string_fields};

import std.text.{char_count as len, parse_i32, from_char, from_i32, from_usize};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;


import nomo.core.text.printable;
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.{Session, allowed_error};
import nomo.harness.harness_model_contract.{bounded, decode_plan};
import nomo.harness.harness_tool_contract.{Ledger, inspect, same};
import nomo.harness.harness_tool_chat_contract.{Previous, TurnResult, prior_error};

public type Identity = { id: string, workspace: string, allowed: Array<string> };
public type Checkpoint = { format: i32, identity: Identity, request: string, task: string, result: string,
    tool: string, outcome: string, answer: string, records: Array<Event>, usage: Ledger, maximum: Ledger,
    admitted: i32, lifecycle: string, resolved: bool };

public flow identity_error(identity: Identity) -> string {
    if !bounded(identity.id, 128) || !bounded(identity.workspace, 128) { return "invalid checkpoint identity"; }
    if count(identity.allowed) > 2 { return "legacy checkpoint supports at most two allowed files"; }
    return allowed_error(identity.allowed);
}

// This is a completed first boundary, not admission to another turn.
public flow validate(saved: Checkpoint, requested: Identity) -> Result<Checkpoint, string> {
    let identity = identity_error(saved.identity); if identity != "" { return Err(identity); }
    let expected = identity_error(requested); if expected != "" { return Err(expected); }
    if saved.identity != requested { return Err("checkpoint identity or workspace binding mismatch"); }
    if saved.format != 1 || saved.admitted != 1 || saved.lifecycle != "completed" || !saved.resolved {
        return Err("checkpoint is not a completed settled first turn");
    }
    if !bounded(saved.request, 128) || !bounded(saved.task, 128) { return Err("invalid checkpoint request or task"); }
    let prior = Previous { task = saved.task, result = saved.result, tool = saved.tool, outcome = saved.outcome, answer = saved.answer };
    let invalid_prior = prior_error(prior); if invalid_prior != "" { return Err(invalid_prior); }
    var tools: i32 = 0;
    var child_count: usize = 4;
    var record_count: usize = 9;
    if saved.tool != "" { tools = 1; child_count = 7; record_count = 13; }
    let exact = Ledger { steps = 5 + tools * 2, calls = 3 + tools, tokens = (3 + tools) * 2048, tools = tools, scan = tools * 4096 };
    if saved.usage != exact { return Err("checkpoint completed usage mismatch"); }
    let maximum = saved.maximum;
    let original_maximum = Ledger { steps = 14, calls = 8, tokens = 16384, tools = 2, scan = 8192 };
    if maximum != original_maximum { return Err("invalid checkpoint invocation limits"); }
    if exact.steps > maximum.steps || exact.calls > maximum.calls || exact.tokens > maximum.tokens ||
        exact.tools > maximum.tools || exact.scan > maximum.scan { return Err("checkpoint usage exceeds saved limits"); }
    let records = saved.records;
    if count(records) != record_count { return Err("invalid checkpoint record count"); }
    let record_error = records_error(records, 4096, "checkpoint");
    if record_error != "" { return Err(record_error); }
    if !same(records[0], "user", "request", "", saved.request) || !same(records[1], "main", "plan", "", records[1].text) ||
        !same(records[2], "main", "delegate", "child-1", saved.task) { return Err("invalid checkpoint planning records"); }
    let task = match decode_plan(records[1].text) { Ok(value) => value, Err(error) => { return Err(error); } };
    if task != saved.task { return Err("checkpoint plan and delegated task disagree"); }
    var events: Array<Event> = [];
    var child_characters: usize = 0;
    var index: usize = 0;
    while index < child_count limit Iterations(7) {
        let event = records[3 + index]; events = events.push(event);
        child_characters = child_characters + len(event.name) + len(event.text); index = index + 1;
    }
    let child_tools: usize = if tools == 1 { 1 } else { 0 };
    let child_calls: usize = if tools == 1 { 2 } else { 1 };
    let child = Session { history = State { events = events, characters = child_characters, spent = 1 + tools * 2, stopped = false },
        calls = child_calls, tokens = child_calls * 2048, tools = child_tools, scan = child_tools * 4096 };
    let observed = match inspect(child, 0, saved.request, saved.task, saved.identity.allowed) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if observed.result != saved.result || observed.tool != saved.tool || observed.outcome != saved.outcome {
        return Err("checkpoint child records and selected result disagree");
    }
    let consumed = 3 + child_count;
    if !same(records[consumed], "main", "consume", "child-1", saved.result) ||
        !same(records[record_count - 1], "main", "answer", "", saved.answer) { return Err("invalid checkpoint consumption records"); }
    if tools == 1 && !same(records[consumed + 1], "main", "tool", saved.tool, saved.outcome) {
        return Err("checkpoint completed tool record mismatch");
    }
    return Ok(saved);
}

public flow from_turn(identity: Identity, turn: TurnResult) -> Result<Checkpoint, string> {
    if turn.status != 0 || !turn.resolved || turn.state.admitted != 1 { return Err("only a successful resolved first turn can be saved"); }
    let completed = match turn.completed { Some(value) => value, None() => { return Err("completed application records missing"); } };
    let prior = Previous { task = completed.task, result = completed.result, tool = completed.tool,
        outcome = completed.outcome, answer = completed.answer };
    if turn.state.prior != prior { return Err("completed result and selected prior disagree"); }
    let saved = Checkpoint { format = 1, identity = identity, request = completed.request, task = completed.task,
        result = completed.result, tool = completed.tool, outcome = completed.outcome, answer = completed.answer,
        records = completed.records, usage = turn.state.usage, maximum = turn.state.maximum,
        admitted = 1, lifecycle = "completed", resolved = true };
    return validate(saved, identity);
}

// Reject nested shapes and bound encoded bytes before JSON parsing/casting.
public flow framed(raw: string, successor: bool) -> bool {
    let limit: usize = if successor { 196608 } else { 65536 };
    if len(raw) == 0 || len(raw) > limit || byte_count(utf8_encode(raw)) > limit { return false; }
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0; var characters: usize = 0; var field_size: usize = 0; var unicode: usize = 0;
    let slash = from_char('\\');
    for codepoint in std.text.chars(raw) limit Iterations(196610) { let character = std.text.from_char(codepoint);
        if character != "" && byte_count(utf8_encode(character)) != 1 { return false; }
        if quoted {
            if unicode > 0 { unicode = unicode - 1; }
            else if escaped { escaped = false; if character == "u" { unicode = 4; } }
            else if character == slash { escaped = true; field_size = field_size + 1; characters = characters + 1; }
            else if character == "\"" { quoted = false; }
            else { field_size = field_size + 1; characters = characters + 1; }
            let maximum: usize = if successor && leaves == 6 { 65536 } else { 1024 };
            if field_size > maximum || characters > (if successor { 73728 } else { 8192 }) { return false; }
        } else if character == "" || character == " " || character == "\n" || character == "\r" || character == "\t" {
        } else if character == "[" { if opened || closed { return false; } opened = true;
        } else if character == "]" { if !opened || closed { return false; } closed = true;
        } else if character == "\"" {
            if !opened || closed { return false; } leaves = leaves + 1;
            if leaves > (if successor { 100 } else { 80 }) { return false; } quoted = true; field_size = 0;
        } else if character != "," || !opened || closed { return false; }
    }
    return opened && closed && !quoted && !escaped && unicode == 0;
}

flow number(raw: string, maximum: i32, label: string) -> Result<i32, string> {
    if len(raw) == 0 || len(raw) > 5 { return Err("invalid canonical " + label + " number"); }
    let value = match parse_i32(raw) { Ok(item) => item, Err(_) => { return Err("invalid canonical " + label + " number"); } };
    if value < 0 || from_i32(value) != raw { return Err("invalid canonical " + label + " number"); }
    if value > maximum { return Err(label + " number exceeds bound"); }
    return Ok(value);
}

public flow read_ledger(fields: Array<string>, offset: usize, label: string) -> Result<Ledger, string> {
    let limits: Array<i32> = [14, 8, 16384, 2, 8192];
    var values: Array<i32> = []; var index: usize = 0;
    while index < 5 limit Iterations(5) {
        let value = match number(fields[offset + index], limits[index], label) { Ok(item) => item, Err(error) => { return Err(error); } };
        values = values.push(value); index = index + 1;
    }
    return Ok(Ledger { steps = values[0], calls = values[1], tokens = values[2], tools = values[3], scan = values[4] });
}

public flow records_error(records: Array<Event>, maximum: usize, label: string) -> string {
    var characters: usize = 0;
    for event in records limit Iterations(18) {
        if len(event.role) > 9 || len(event.kind) > 8 || len(event.name) > 8 || len(event.text) > 512 ||
            !printable(event.role) || !printable(event.kind) || !printable(event.name) || !printable(event.text) { return "invalid " + label + " record data"; }
        characters = characters + len(event.name) + len(event.text);
        if characters > maximum { return label + " record content exceeds bound"; }
    }
    return "";
}
public flow fields_error(fields: Array<string>, successor: bool) -> string {
    let error = (if successor { "successor" } else { "checkpoint" }) + " string fields exceed bounds";
    if count(fields) > (if successor { 100 } else { 80 }) { return error; }
    var characters: usize = 0; var index: usize = 0;
    for field in fields limit Iterations(100) {
        if len(field) > (if successor && index == 5 { 65536 } else { 1024 }) { return error; }
        characters = characters + len(field); index = index + 1;
        if characters > (if successor { 73728 } else { 8192 }) { return error; }
    }
    return "";
}

public flow encode(saved: Checkpoint) -> Result<string, string> {
    match validate(saved, saved.identity) { Err(error) => { return Err(error); } Ok(_) => {} }
    var second = ""; if count(saved.identity.allowed) == 2 { second = saved.identity.allowed[1]; }
    var fields = ["nomo-harness-checkpoint-v1", saved.identity.id, saved.identity.workspace, saved.identity.allowed[0], second,
        saved.request, saved.task, saved.result, saved.tool, saved.outcome, saved.answer,
        from_i32(saved.usage.steps), from_i32(saved.usage.calls), from_i32(saved.usage.tokens),
        from_i32(saved.usage.tools), from_i32(saved.usage.scan), from_i32(saved.maximum.steps),
        from_i32(saved.maximum.calls), from_i32(saved.maximum.tokens), from_i32(saved.maximum.tools),
        from_i32(saved.maximum.scan), "1", "completed", "true", from_usize(count(saved.records))];
    for event in saved.records limit Iterations(13) {
        fields = fields.push(event.role); fields = fields.push(event.kind); fields = fields.push(event.name); fields = fields.push(event.text);
    }
    let invalid_fields = fields_error(fields, false); if invalid_fields != "" { return Err(invalid_fields); }
    let encoded = match encode_json(fields, "checkpoint encoding conversion refused", "checkpoint JSON encoding refused") { Ok(value) => value, Err(error) => { return Err(error); } };
    if !framed(encoded, false) { return Err("checkpoint encoded bounds exceeded"); }
    return Ok(encoded);
}

public flow decode(raw: string) -> Result<Checkpoint, string> {
    if !framed(raw, false) { return Err("checkpoint encoded shape or bounds invalid"); }
    let fields = match string_fields(raw, "invalid checkpoint JSON", "checkpoint fields must be strings") { Ok(value) => value, Err(error) => { return Err(error); } };
    let invalid_fields = fields_error(fields, false); if invalid_fields != "" { return Err(invalid_fields); }
    if count(fields) != 61 && count(fields) != 77 { return Err("invalid checkpoint field count"); }
    if fields[0] != "nomo-harness-checkpoint-v1" { return Err("unsupported checkpoint format"); }
    if fields[21] != "1" || fields[22] != "completed" || fields[23] != "true" { return Err("checkpoint is not completed and settled"); }
    var record_count: usize = 9; if count(fields) == 77 { record_count = 13; }
    if fields[24] != from_usize(record_count) { return Err("checkpoint record count disagrees with framing"); }
    var allowed = [fields[3]]; if fields[4] != "" { allowed = allowed.push(fields[4]); }
    let identity = Identity { id = fields[1], workspace = fields[2], allowed = allowed };
    let usage = match read_ledger(fields, 11, "checkpoint") { Ok(value) => value, Err(error) => { return Err(error); } };
    let maximum = match read_ledger(fields, 16, "checkpoint") { Ok(value) => value, Err(error) => { return Err(error); } };
    var records: Array<Event> = []; var index: usize = 0;
    while index < record_count limit Iterations(13) {
        let offset = 25 + index * 4;
        records = records.push(Event { role = fields[offset], kind = fields[offset + 1], name = fields[offset + 2], text = fields[offset + 3] });
        index = index + 1;
    }
    let saved = Checkpoint { format = 1, identity = identity, request = fields[5], task = fields[6], result = fields[7],
        tool = fields[8], outcome = fields[9], answer = fields[10], records = records, usage = usage, maximum = maximum,
        admitted = 1, lifecycle = "completed", resolved = true };
    return validate(saved, identity);
}
