module nomo.session.recoverable_chat_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, MemoryEntry, MemoryVersion,
    WriteCondition, WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.chat_session_contract.{Session, fresh, invalid as invalid_chat, begin, complete};
import nomo.harness.harness_tool_chat_contract.TurnResult;
import nomo.session.redaction.{Policy, policy_error, text as redact};
import nomo.session.recoverable_events.{Frame as EventFrame, empty as empty_events, invalid as invalid_events, append};
import nomo.session.event_text_codec.{encode, decode};
import nomo.core.conversation.Event;
import std.collections.len as count;
import std.text.{len, split};

// The opt-in read-only path joins the chat reservation and filtered event batch
// in one CAS record. Each access must supply the same bound trusted policy.
// Known-literal filtering is not comprehensive secret detection; the record
// does not establish workspace identity, grant authority, or support work/check.
public type Frame = { format: i32, encoding: string, policy_binding: string, chat: Session, events: EventFrame };
alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;
let Frames = std.memory.region<Schema>(stable_id = "nomo-recoverable-chat-v1", store = "recoverable-chat");

flow binding_error(binding: string) -> string {
    if len(binding) != 64 { return "invalid event policy binding"; }
    for c in split(binding, "") limit Iterations(66) {
        if c != "" && c != "0" && c != "1" && c != "2" && c != "3" && c != "4" && c != "5" && c != "6" && c != "7" && c != "8" && c != "9" && c != "a" && c != "b" && c != "c" && c != "d" && c != "e" && c != "f" { return "invalid event policy binding"; }
    }
    return "";
}

flow frame_error(value: Frame, policy: Policy, binding: string) -> string {
    let bound = binding_error(binding); if bound != "" { return bound; }
    if value.format != 1 || value.encoding != "json-string-v1" || value.policy_binding != binding { return "invalid recoverable chat format, encoding or policy binding"; }
    let chat_error = invalid_chat(value.chat); if chat_error != "" { return chat_error; }
    let event_error = invalid_events(value.events, policy); if event_error != "" { return event_error; }
    for item in value.events.events limit Iterations(48) {
        match decode(item.text, policy) { Ok(_) => {} Err(error) => { return error; } }
    }
    if value.chat.invocation.admitted != value.events.turns { return "chat and event turns differ"; }
    let prior = value.chat.invocation.prior;
    for field in [value.chat.last_request, value.chat.pending, prior.task, prior.result, prior.tool, prior.outcome, prior.answer] limit Iterations(7) {
        let checked = match redact(field, policy) { Ok(item) => item, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "chat contains a known sensitive literal"; }
    }
    return "";
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    let problem = policy_error(policy); if problem != "" { return Err(problem); }
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    let entry = get_entry(Frames.Rows, "latest");
    match entry {
        Some(item) => {
            if item.key != "latest" { return Err("recoverable chat key mismatch"); }
            let error = frame_error(item.value, policy, binding); if error != "" { return Err(error); }
        }
        None() => {}
    }
    return Ok(entry);
}

flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(value, policy, binding); if error != "" { return Err(error); }
    let observed = match load(policy, binding) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if observed != expected { return Err("recoverable chat changed; no retry"); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let intent = prepare_put(Frames.Rows, "latest", value, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("recoverable chat commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("recoverable chat commit refused; no retry"); }
        WriteOutcome.Committed(item) => item,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "latest" || receipt.target.region != "nomo-recoverable-chat-v1" || receipt.target.store != ["Rows"] {
        return Err("recoverable chat receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("recoverable chat version missing"); } };
    let after = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("recoverable chat readback missing"); } };
    if after.value != value || after.version.opaque != version.opaque { return Err("recoverable chat readback mismatch; no retry"); }
    match expected { Some(item) => { if item.version.opaque == version.opaque { return Err("recoverable chat version did not change"); } } None() => {} }
    return Ok(version);
}

public flow create(policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return write(Frame { format = 1, encoding = "json-string-v1", policy_binding = binding, chat = fresh(), events = empty_events() }, None(), policy, binding);
}

public flow reserve(expected: MemoryEntry<string, Frame>, request: string, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(expected.value, policy, binding); if error != "" { return Err(error); }
    let pending = match begin(expected.value.chat, request) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    return write(Frame { format = 1, encoding = "json-string-v1", policy_binding = binding, chat = pending, events = expected.value.events }, Some(expected), policy, binding);
}

public flow finish(expected: MemoryEntry<string, Frame>, result: TurnResult, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(expected.value, policy, binding); if error != "" { return Err(error); }
    let completed = match result.completed { Some(item) => item, None() => { return Err("completed event batch missing"); } };
    let chat = match complete(expected.value.chat, result) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if count(completed.records) == 0 || count(completed.records) > 24 { return Err("invalid completed event batch"); }
    var encoded: Array<Event> = [];
    for item in completed.records limit Iterations(24) {
        let text = match encode(item.text, policy) { Ok(value) => value.value, Err(problem) => { return Err(problem); } };
        // The shared legacy read controller used the literal "qwen" for a
        // generic model-text event, including under MiniMax. Do not persist it
        // as a provider identity in the provider-independent record.
        let name = if item.role == "model" && item.kind == "text" && item.name == "qwen" { "" } else { item.name };
        encoded = encoded.push(Event { role = item.role, kind = item.kind, name = name, text = text });
    }
    let events = match append(expected.value.events, chat.invocation.admitted, encoded, policy) {
        Ok(item) => item.frame, Err(problem) => { return Err(problem); }
    };
    return write(Frame { format = 1, encoding = "json-string-v1", policy_binding = binding, chat = chat, events = events }, Some(expected), policy, binding);
}
