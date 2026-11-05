module nomo.session.work_record;

import nomo.core.json.{encode as encode_json, string_fields};

import std.text.{char_count as len, from_char, from_i32, from_usize};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.parse;
import std.agent.message.Message;
import nomo.core.text.flat_string_frame;
import nomo.session.edit_operation.{Binding, binding_error, same_binding};
import nomo.harness.harness_work_contract.{Evidence, Ledger, evidence_error};
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_edit_contract.Ledger as EditLedger;
import nomo.harness.harness_edit_contract.text_error;
import nomo.tools.edit_contract.{Prepared, prepare_original};
import nomo.tools.edit_binding.bind;

public type Record = { format: i32, phase: string, binding: Binding, body: string };
public type Captured = { binding: Binding, evidence: Evidence, task: string, target: string, replacement: string,
    before: string, after: string, summary: string, ledger: Ledger };

flow stage(confirmed: bool, read: ReadLedger) -> Ledger {
    return Ledger { read = read, edit = EditLedger { steps = if confirmed { 6 } else { 5 },
        calls = if confirmed { 3 } else { 2 }, tokens = if confirmed { 38912 } else { 36864 },
        native_tokens = if confirmed { 163840 } else { 98304 }, boundaries = 3 } };
}

// This frame admits quoted Unicode. The native parser subsequently checks
// separators and escapes; no nested or non-string leaf reaches decoding.
flow framed(raw: string) -> bool { return flat_string_frame(raw, 52, true); }

flow fields_error(fields: Array<string>) -> string {
    if count(fields) != 52 { return "work record requires exactly 52 string fields"; }
    var total: usize = 0;
    for field in fields limit Iterations(52) {
        if len(field) > 2048 { return "work record field exceeds 2048 decoded UTF-8 bytes"; }
        let size = byte_count(utf8_encode(field)); total = total + size;
        if size > 2048 || total > 12288 { return "work record exceeds decoded UTF-8 byte bounds"; }
    }
    return "";
}

flow decode(body: string) -> Result<Array<string>, string> {
    if !framed(body) { return Err("work record encoded framing or 65536-byte bound invalid"); }
    let fields = match string_fields(body, "invalid work record JSON", "work record fields must be strings") { Ok(value) => value, Err(error) => { return Err(error); } };
    let invalid = fields_error(fields); if invalid != "" { return Err(invalid); }
    return Ok(fields);
}

flow outer_error(row: Record) -> string {
    let encoded = match encode_json(row, "work row conversion refused", "work row serialization refused") { Ok(value) => value, Err(error) => { return error; } };
    if byte_count(utf8_encode(encoded)) > 131072 { return "work row exceeds 131072 serialized UTF-8 bytes"; }
    return "";
}

flow fields(value: Captured, phase: string) -> Array<string> {
    let binding = value.binding; let read = value.ledger.read; let edit = value.ledger.edit;
    var allowed_second = ""; if count(value.evidence.allowed) == 2 { allowed_second = value.evidence.allowed[1]; }
    var selected_second = ""; if count(value.evidence.files) == 2 { selected_second = value.evidence.files[1]; }
    let confirmed = phase == "summary-confirmed";
    return ["nomo-work-record-v1", phase, binding.id, binding.workspace, binding.region, binding.path,
        binding.request_digest, binding.before_digest, binding.after_digest,
        from_usize(binding.before_bytes), from_usize(binding.after_bytes), value.evidence.request,
        value.evidence.task, value.evidence.operation, value.evidence.allowed[0], allowed_second,
        value.evidence.files[0], selected_second, value.evidence.literal, value.evidence.outcome,
        value.evidence.result, value.evidence.summary, value.task, value.target, value.replacement,
        value.before, value.after, value.summary, from_i32(read.steps), from_i32(read.calls),
        from_i32(read.tokens), from_i32(read.tools), from_i32(read.scan),
        from_i32(edit.steps), from_i32(edit.calls), from_i32(edit.tokens),
        from_i32(edit.native_tokens), from_i32(edit.boundaries),
        "13", "7", "47104", "196608", "1", "4096", "3", "6144", "1", "2048",
        if confirmed { "0" } else { "1" }, if confirmed { "0" } else { "1" },
        if confirmed { "0" } else { "2048" }, if confirmed { "0" } else { "65536" }];
}

flow encode(value: Captured, phase: string) -> Result<Record, string> {
    if count(value.evidence.allowed) > 2 || count(value.evidence.files) > 2 { return Err("legacy work record supports at most two files"); }
    let projection = fields(value, phase);
    let invalid = fields_error(projection); if invalid != "" { return Err(invalid); }
    let body = match encode_json(projection, "work body conversion refused", "work body encoding refused") { Ok(value) => value, Err(error) => { return Err(error); } };
    if !framed(body) { return Err("work record encoded bounds exceeded"); }
    let row = Record { format = 1, phase = phase, binding = value.binding, body = body };
    let outer = outer_error(row); if outer != "" { return Err(outer); }
    return Ok(row);
}

public flow validate(row: Record) -> Result<Captured, string> {
    if row.format != 1 || (row.phase != "summary-unconfirmed" && row.phase != "summary-confirmed") {
        return Err("unsupported work record format or phase");
    }
    let invalid = binding_error(row.binding); if invalid != "" { return Err(invalid); }
    let data = match decode(row.body) { Ok(value) => value, Err(error) => { return Err(error); } };
    if data[0] != "nomo-work-record-v1" || data[1] != row.phase { return Err("work body marker or phase mismatch"); }
    let prepared = match prepare_original(data[5], data[25], data[23], data[24]) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if prepared.proposal.before == "" || prepared.proposal.after != data[26] { return Err("work literal edit result mismatch"); }
    let binding = match bind(data[2], data[3], data[5], prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    if !same_binding(binding, row.binding) || data[4] != binding.region || data[6] != binding.request_digest ||
        data[7] != binding.before_digest || data[8] != binding.after_digest ||
        data[9] != from_usize(binding.before_bytes) || data[10] != from_usize(binding.after_bytes) {
        return Err("work body or outer edit binding mismatch");
    }
    var allowed = [data[14]]; if data[15] != "" { allowed = allowed.push(data[15]); }
    var selected = [data[16]]; if data[17] != "" { selected = selected.push(data[17]); }
    let read = ReadLedger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 };
    let evidence = Evidence { request = data[11], task = data[12], operation = data[13], files = selected,
        literal = data[18], outcome = data[19], result = data[20], summary = data[21], allowed = allowed, ledger = read };
    let invalid_evidence = evidence_error(evidence); if invalid_evidence != "" { return Err(invalid_evidence); }
    let invalid_task = text_error(data[22], "saved edit task"); if invalid_task != "" { return Err(invalid_task); }
    let confirmed = row.phase == "summary-confirmed";
    if confirmed {
        let summary = text_error(data[27], "saved final summary"); if summary != "" { return Err(summary); }
    } else if data[27] != "" { return Err("unconfirmed work record carries a final summary"); }
    let captured = Captured { binding = binding, evidence = evidence, task = data[22], target = data[23],
        replacement = data[24], before = data[25], after = data[26], summary = data[27], ledger = stage(confirmed, read) };
    // Exact canonical strings reject leading zeros, signs and every other
    // stage/maxima/reservation value without parsing untrusted integers.
    if fields(captured, row.phase) != data { return Err("work record canonical counters or projection mismatch"); }
    let outer = outer_error(row); if outer != "" { return Err(outer); }
    return Ok(captured);
}

// A predicted valid binding is admission data, never completion authority.
// Only the caller's matched typed Confirmed result permits publication.
public flow partial(binding: Binding, evidence: Evidence, task: string, prepared: Prepared) -> Result<Record, string> {
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    let proof = evidence_error(evidence); if proof != "" { return Err(proof); }
    let invalid_task = text_error(task, "saved edit task"); if invalid_task != "" { return Err(invalid_task); }
    let selected = match bind(binding.id, binding.workspace, binding.path, prepared) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if !same_binding(selected, binding) { return Err("work admission binding mismatch"); }
    let captured = Captured { binding = binding, evidence = evidence, task = task, target = prepared.request.target,
        replacement = prepared.request.replacement, before = prepared.proposal.before, after = prepared.proposal.after,
        summary = "", ledger = stage(false, evidence.ledger) };
    let row = match encode(captured, "summary-unconfirmed") { Ok(value) => value, Err(error) => { return Err(error); } };
    match validate(row) { Ok(_) => {} Err(error) => { return Err(error); } }
    return Ok(row);
}

public flow confirm(row: Record, summary: string) -> Result<Record, string> {
    let captured = match validate(row) { Ok(value) => value, Err(error) => { return Err(error); } };
    if row.phase != "summary-unconfirmed" { return Err("work summary update requires an unconfirmed record"); }
    let invalid = text_error(summary, "saved final summary"); if invalid != "" { return Err(invalid); }
    let complete = Captured { binding = captured.binding, evidence = captured.evidence, task = captured.task,
        target = captured.target, replacement = captured.replacement, before = captured.before, after = captured.after,
        summary = summary, ledger = stage(true, captured.evidence.ledger) };
    let result = match encode(complete, "summary-confirmed") { Ok(value) => value, Err(error) => { return Err(error); } };
    match validate(result) { Ok(_) => {} Err(error) => { return Err(error); } }
    return Ok(result);
}

// This hypothetical summary supplies the maximum escape expansion, including
// second escaping in the complete row. Capacity admission grants no completion
// authority and does not require the hypothetical text to be a valid summary.
public flow admit(row: Record) -> Result<bool, string> {
    let captured = match validate(row) { Ok(value) => value, Err(error) => { return Err(error); } };
    if row.phase != "summary-unconfirmed" { return Err("work admission requires an unconfirmed candidate"); }
    let sentinel = "\"" + from_char('\\') + "u0001\"";
    let parsed = match parse(sentinel) { Ok(value) => value, Err(_) => { return Err("work admission sentinel decode refused"); } };
    let message = Message.new(parsed); let converted: Option<Message<string>> = message.cast<string>();
    let control = match converted { Some(value) => value.body, None() => { return Err("work admission sentinel conversion refused"); } };
    let control_bytes = utf8_encode(control);
    if byte_count(control_bytes) != 1 { return Err("work admission sentinel must be exactly one UTF-8 byte"); }
    let expected: u8 = 1;
    if control_bytes[0] != expected { return Err("work admission sentinel must be U+0001"); }
    var summary = ""; var index: usize = 0;
    while index < 512 limit Iterations(512) { summary = summary + control; index = index + 1; }
    let hypothetical = Captured { binding = captured.binding, evidence = captured.evidence, task = captured.task,
        target = captured.target, replacement = captured.replacement, before = captured.before, after = captured.after,
        summary = summary, ledger = stage(true, captured.evidence.ledger) };
    return match encode(hypothetical, "summary-confirmed") { Ok(_) => Ok(true), Err(error) => Err(error) };
}

public flow same_record(left: Record, right: Record) -> bool { return left == right; }
