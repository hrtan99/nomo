module nomo.session.work_chain;

import std.text.{len, split, starts_with, to_string_usize};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.session.edit_operation.selector_error;
import nomo.model.model_tool_contract.{question_error, allowed_error};
import nomo.session.work_record.Record as WorkRecord;
import nomo.session.work_record.validate as validate_work;
import nomo.session.work_record.confirm as confirm_work;
import nomo.tools.edit_encoding.digest;

public type Caps = { steps: i32, calls: i32, generation: i32, native_tokens: i32, read_tools: i32,
    scan: i32, edit_reads: i32, edit_read_bytes: i32, atomic: i32, atomic_bytes: i32 };
public type Reservation = { available: Caps, remaining: Caps };
public type Record = { format: i32, phase: string, chain: string, turn: i32, id: string,
    workspace: string, region: string, path: string, request: string, allowed: Array<string>,
    parent_id: string, parent_version: string, parent_digest: string, maximum: Caps,
    available: Caps, remaining: Caps, reserved: Caps, work: Option<WorkRecord> };

public flow values(value: Caps) -> Array<i32> {
    return [value.steps, value.calls, value.generation, value.native_tokens, value.read_tools,
        value.scan, value.edit_reads, value.edit_read_bytes, value.atomic, value.atomic_bytes];
}
flow caps(value: Array<i32>) -> Caps {
    return Caps { steps = value[0], calls = value[1], generation = value[2], native_tokens = value[3],
        read_tools = value[4], scan = value[5], edit_reads = value[6], edit_read_bytes = value[7], atomic = value[8], atomic_bytes = value[9] };
}
public flow lifetime() -> Caps { return caps([26, 14, 94208, 393216, 2, 8192, 6, 12288, 2, 4096]); }
public flow maximum() -> Caps { return lifetime(); }
public flow turn_caps() -> Caps { return caps([13, 7, 47104, 196608, 1, 4096, 3, 6144, 1, 2048]); }
public flow zero() -> Caps { return caps([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); }
public flow summary_reservation() -> Caps { return caps([1, 1, 2048, 65536, 0, 0, 0, 0, 0, 0]); }

public flow caps_error(value: Caps) -> string {
    let numbers = values(value); let maximum = values(lifetime()); var index: usize = 0;
    while index < 10 limit Iterations(10) {
        if numbers[index] < 0 || numbers[index] > maximum[index] { return "invalid bounded work-chain allowance"; }
        index = index + 1;
    }
    return "";
}
public flow policy_error(value: Caps) -> string {
    let numbers = values(value); let maximum = values(turn_caps()); var index: usize = 0;
    while index < 10 limit Iterations(10) {
        if numbers[index] < 0 || numbers[index] > maximum[index] { return "invalid current single-turn work-chain policy"; }
        index = index + 1;
    }
    return "";
}
public flow reserve(saved: Caps, policy: Caps) -> Result<Reservation, string> {
    let invalid_saved = caps_error(saved); if invalid_saved != "" { return Err(invalid_saved); }
    let invalid_policy = policy_error(policy); if invalid_policy != "" { return Err(invalid_policy); }
    let previous = values(saved); let current = values(policy); let required = values(turn_caps());
    var admitted: Array<i32> = []; var remaining: Array<i32> = []; var index: usize = 0;
    while index < 10 limit Iterations(10) {
        let available = if previous[index] < current[index] { previous[index] } else { current[index] };
        if available < required[index] { return Err("work-chain remaining/current policy cannot reserve a complete turn"); }
        admitted = admitted.push(available); remaining = remaining.push(previous[index] - required[index]); index = index + 1;
    }
    return Ok(Reservation { available = caps(admitted), remaining = caps(remaining) });
}
public flow parse_policy(raw: string) -> Result<Caps, string> {
    if len(raw) == 0 || len(raw) > 128 { return Err("expected ten canonical work-chain policy counters"); }
    let fields = split(raw, ","); if count(fields) != 10 { return Err("expected ten canonical work-chain policy counters"); }
    var numbers: Array<i32> = [];
    for field in fields limit Iterations(10) {
        if len(field) == 0 || len(field) > 6 || (len(field) > 1 && starts_with(field, "0")) { return Err("invalid canonical work-chain counter"); }
        var number: i32 = 0;
        for character in split(field, "") limit Iterations(8) {
            if character != "" {
                let digit: i32 = match character { "0" => 0, "1" => 1, "2" => 2, "3" => 3, "4" => 4,
                    "5" => 5, "6" => 6, "7" => 7, "8" => 8, "9" => 9, _ => { return Err("invalid canonical work-chain counter"); } };
                number = number * 10 + digit;
            }
        }
        numbers = numbers.push(number);
    }
    let result = caps(numbers); let invalid = policy_error(result); if invalid != "" { return Err(invalid); }
    return Ok(result);
}

public flow policy(raw: string) -> Result<Caps, string> { return parse_policy(raw); }

flow serialized(row: Record) -> Result<string, string> {
    let message = Message.new(row); let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match converted { Some(value) => value.body, None() => { return Err("work-chain row conversion refused"); } };
    let encoded = match stringify(data) { Ok(value) => value, Err(_) => { return Err("work-chain row serialization refused"); } };
    if byte_count(utf8_encode(encoded)) > 262144 { return Err("work-chain row exceeds 262144 serialized UTF-8 bytes"); }
    return Ok(encoded);
}

public flow validate(row: Record) -> string {
    if row.format != 2 || (row.turn != 1 && row.turn != 2) ||
        (row.phase != "admitted" && row.phase != "summary-unconfirmed" && row.phase != "summary-confirmed") {
        return "invalid work-chain v2 format, turn or phase";
    }
    let identity = selector_error(row.id, row.workspace, row.path); if identity != "" { return identity; }
    let chain = selector_error(row.chain, row.workspace, row.path); if chain != "" { return chain; }
    if row.region != "nomo.tools.edit_file.EditableRoot" { return "work-chain region binding mismatch"; }
    let request = question_error(row.request); if request != "" { return request; }
    let allowed = allowed_error(row.allowed); if allowed != "" { return allowed; }
    if row.maximum != lifetime() { return "work-chain lifetime allowance changed"; }
    let saved = if row.turn == 1 { lifetime() } else { turn_caps() };
    let reservation = match reserve(saved, row.available) { Ok(value) => value, Err(error) => { return error; } };
    if row.available != reservation.available || row.remaining != reservation.remaining { return "work-chain reservation conservation mismatch"; }
    if row.turn == 1 {
        if row.id != row.chain || row.parent_id != "" || row.parent_version != "" || row.parent_digest != "" {
            return "invalid work-chain root lineage";
        }
    } else {
        if row.id == row.chain || row.parent_id != row.chain || len(row.parent_version) == 0 ||
            byte_count(utf8_encode(row.parent_version)) > 512 || len(row.parent_digest) != 64 {
            return "invalid work-chain successor lineage";
        }
        if row.available != turn_caps() || row.remaining != zero() { return "work-chain second-turn allowance mismatch"; }
    }
    if row.phase == "admitted" {
        if row.work != None() || row.reserved != turn_caps() { return "invalid work-chain admitted reservation"; }
    } else {
        let work = match row.work { Some(value) => value, None() => { return "completed edit work missing from chain"; } };
        let captured = match validate_work(work) { Ok(value) => value, Err(error) => { return error; } };
        if work.phase != row.phase || captured.binding.id != row.id || captured.binding.workspace != row.workspace ||
            captured.binding.region != row.region || captured.binding.path != row.path || captured.evidence.request != row.request ||
            captured.evidence.allowed != row.allowed { return "work-chain captured work binding mismatch"; }
        let expected = if row.phase == "summary-confirmed" { zero() } else { summary_reservation() };
        if row.reserved != expected { return "invalid work-chain final reservation"; }
    }
    var decoded: usize = 0;
    for field in [row.phase, row.chain, row.id, row.workspace, row.region, row.path, row.request,
        row.parent_id, row.parent_version, row.parent_digest] limit Iterations(10) {
        decoded = decoded + byte_count(utf8_encode(field));
    }
    for field in row.allowed limit Iterations(2) { decoded = decoded + byte_count(utf8_encode(field)); }
    // Count the separately bounded decoded projection rather than its escaped body.
    // The fixed scalar/counter overhead is conservatively included as 512 bytes.
    decoded = decoded + 512;
    match row.work {
        Some(value) => {
            let binding = value.binding;
            for field in [value.phase, binding.id, binding.workspace, binding.region, binding.path,
                binding.request_digest, binding.before_digest, binding.after_digest,
                to_string_usize(binding.before_bytes), to_string_usize(binding.after_bytes)] limit Iterations(10) {
                decoded = decoded + byte_count(utf8_encode(field));
            }
            decoded = decoded + 12288;
        }
        None() => {}
    }
    if decoded > 16384 { return "work-chain decoded metadata plus work exceeds 16384 bytes"; }
    return match serialized(row) { Ok(_) => "", Err(error) => error };
}

public flow fingerprint(row: Record) -> Result<string, string> {
    let invalid = validate(row); if invalid != "" { return Err(invalid); }
    let encoded = match serialized(row) { Ok(value) => value, Err(error) => { return Err(error); } };
    return digest(encoded);
}

public flow initial(id: string, workspace: string, path: string, request: string, allowed: Array<string>, policy: Caps) -> Result<Record, string> {
    let reservation = match reserve(lifetime(), policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let row = Record { format = 2, phase = "admitted", chain = id, turn = 1, id = id, workspace = workspace,
        region = "nomo.tools.edit_file.EditableRoot", path = path, request = request, allowed = allowed,
        parent_id = "", parent_version = "", parent_digest = "", maximum = lifetime(), available = reservation.available,
        remaining = reservation.remaining, reserved = turn_caps(), work = None() };
    let invalid = validate(row); if invalid != "" { return Err(invalid); }
    return Ok(row);
}

public flow successor(parent: Record, parent_version: string, id: string, request: string, allowed: Array<string>, policy: Caps) -> Result<Record, string> {
    let invalid = validate(parent); if invalid != "" { return Err(invalid); }
    if parent.turn != 1 || parent.phase != "summary-confirmed" { return Err("only a confirmed first v2 turn can continue; no third turn or v1 upgrade"); }
    let reservation = match reserve(parent.remaining, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let proof = match fingerprint(parent) { Ok(value) => value, Err(error) => { return Err(error); } };
    let row = Record { format = 2, phase = "admitted", chain = parent.chain, turn = 2, id = id, workspace = parent.workspace,
        region = parent.region, path = parent.path, request = request, allowed = allowed, parent_id = parent.id,
        parent_version = parent_version, parent_digest = proof, maximum = parent.maximum, available = reservation.available,
        remaining = reservation.remaining, reserved = turn_caps(), work = None() };
    let error = validate(row); if error != "" { return Err(error); }
    if allowed != parent.allowed { return Err("work-chain allowed-file binding changed"); }
    return Ok(row);
}

public flow linked(parent: Record, parent_version: string, child: Record) -> string {
    let invalid = validate(parent); if invalid != "" { return invalid; }
    let invalid_child = validate(child); if invalid_child != "" { return invalid_child; }
    if parent.turn != 1 || parent.phase != "summary-confirmed" || child.turn != 2 || child.parent_id != parent.id ||
        child.chain != parent.chain || child.workspace != parent.workspace || child.region != parent.region ||
        child.path != parent.path || child.allowed != parent.allowed || child.parent_version != parent_version ||
        child.id == parent.id { return "work-chain parent or workspace binding mismatch"; }
    let proof = match fingerprint(parent) { Ok(value) => value, Err(error) => { return error; } };
    if child.parent_digest != proof { return "work-chain parent digest changed"; }
    let reserved = match reserve(parent.remaining, child.available) { Ok(value) => value, Err(error) => { return error; } };
    if child.available != reserved.available || child.remaining != reserved.remaining { return "work-chain saved allowance changed"; }
    let previous = match parent.work { Some(value) => value, None() => { return "confirmed parent work missing"; } };
    let prior = match validate_work(previous) { Ok(value) => value, Err(error) => { return error; } };
    match child.work {
        Some(value) => {
            let current = match validate_work(value) { Ok(item) => item, Err(error) => { return error; } };
            if current.before != prior.after { return "work-chain original differs from captured parent result"; }
        }
        None() => {}
    }
    return "";
}

public flow publish_partial(row: Record, work: WorkRecord) -> Result<Record, string> {
    let invalid = validate(row); if invalid != "" { return Err(invalid); }
    if row.phase != "admitted" || work.phase != "summary-unconfirmed" { return Err("chain partial requires its original admission and confirmed edit"); }
    let result = Record { format = row.format, phase = "summary-unconfirmed", chain = row.chain, turn = row.turn, id = row.id,
        workspace = row.workspace, region = row.region, path = row.path, request = row.request, allowed = row.allowed,
        parent_id = row.parent_id, parent_version = row.parent_version, parent_digest = row.parent_digest, maximum = row.maximum,
        available = row.available, remaining = row.remaining, reserved = summary_reservation(), work = Some(work) };
    let error = validate(result); if error != "" { return Err(error); }
    return Ok(result);
}

public flow confirm(row: Record, summary: string) -> Result<Record, string> {
    let invalid = validate(row); if invalid != "" { return Err(invalid); }
    if row.phase != "summary-unconfirmed" { return Err("chain summary requires an unconfirmed work record"); }
    let work = match row.work { Some(value) => value, None() => { return Err("chain partial work missing"); } };
    let completed = match confirm_work(work, summary) { Ok(value) => value, Err(error) => { return Err(error); } };
    let result = Record { format = row.format, phase = "summary-confirmed", chain = row.chain, turn = row.turn, id = row.id,
        workspace = row.workspace, region = row.region, path = row.path, request = row.request, allowed = row.allowed,
        parent_id = row.parent_id, parent_version = row.parent_version, parent_digest = row.parent_digest, maximum = row.maximum,
        available = row.available, remaining = row.remaining, reserved = zero(), work = Some(completed) };
    let error = validate(result); if error != "" { return Err(error); }
    return Ok(result);
}
