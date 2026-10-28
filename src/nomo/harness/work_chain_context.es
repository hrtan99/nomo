module nomo.harness.work_chain_context;

import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.session.work_chain.{Record, validate};
import nomo.session.work_record.validate as work;
import nomo.harness.harness_work_contract.{Context, context_error};

public type ParentFacts = { chain: string, root: string, id: string, turn: i32, after_digest: string, request: string,
    read_task: string, operation: string, files: Array<string>, literal: string, outcome: string, result: string, read_summary: string, final_summary: string };
public type Input = { current: Context, parent: Array<ParentFacts> };
public flow parent_facts(parent: Record) -> Result<Array<ParentFacts>, string> {
    let invalid = validate(parent); if invalid != "" { return Err(invalid); }
    if parent.turn != 1 || parent.phase != "summary-confirmed" { return Err("only a confirmed first v2 parent supplies context"); }
    let record = match parent.work { Some(value) => value, None() => { return Err("confirmed parent work missing"); } };
    let value = match work(record) { Ok(item) => item, Err(error) => { return Err(error); } };
    let read = value.evidence;
    let result = [ParentFacts { chain = parent.chain, root = parent.chain, id = parent.id, turn = parent.turn,
        after_digest = value.binding.after_digest, request = read.request, read_task = read.task, operation = read.operation,
        files = read.files, literal = read.literal, outcome = read.outcome, result = read.result, read_summary = read.summary, final_summary = value.summary }];
    let message = Message.new(result); let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match converted { Some(item) => item.body, None() => { return Err("parent facts conversion refused"); } };
    let encoded = match stringify(data) { Ok(item) => item, Err(_) => { return Err("parent facts encoding refused"); } };
    if byte_count(utf8_encode(encoded)) > 8192 { return Err("parent facts exceed 8192 UTF-8 bytes before admission"); }
    return Ok(result);
}
public flow combined(current: Context, parent: Array<ParentFacts>) -> Input {
    let error = context_error(current); if error != "" { abort(error); }
    if count(parent) > 1 { abort("at most one confirmed parent context"); }
    let value = Input { current = current, parent = parent };
    let message = Message.new(value); let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match converted { Some(item) => item.body, None() => { abort("chain context conversion refused"); } };
    let encoded = match stringify(data) { Ok(item) => item, Err(_) => { abort("chain context encoding refused"); } };
    if byte_count(utf8_encode(encoded)) > 81920 { abort("chain edit context exceeds 81920 UTF-8 bytes"); }
    return value;
}
