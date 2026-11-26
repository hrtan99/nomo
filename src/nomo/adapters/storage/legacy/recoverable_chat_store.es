module nomo.adapters.storage.legacy.recoverable_chat_store;

import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_native;
import std.memory.{MemoryEntry, MemoryVersion, Missing, Match};
import nomo.domain.sessions.chat_session_contract.{fresh_events, fresh_high_input_events, invalid as invalid_chat, begin, complete, extend};
import nomo.domain.harness.harness_tool_chat_contract.TurnResult;
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.domain.sessions.redaction.{Policy, policy_error, text as redact};
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.domain.sessions.recoverable_events.{empty as empty_events, invalid as invalid_events, shape_error as event_shape_error, append_encoded, work_batch};
import nomo.domain.sessions.event_text_codec.{encode, decode, encode_prefix};
import nomo.adapters.storage.legacy.history_check_store.invalid_values;
import nomo.core.conversation.Event;
import nomo.domain.text.text.hex_digest;
import nomo.domain.context.large_context.timeline_inline_bytes;
import std.text.{from_i32, len as byte_len};
import nomo.session.recoverable_chat_store.{Frame, Frames, Evidence, EvidenceFrames};

flow binding_error(binding: string) -> string { return if hex_digest(binding) { "" } else { "invalid event policy binding" }; }

flow large_work_duplicate(item: Event) -> bool {
    return ((item.role == "main" && item.kind == "tool") || (item.role == "tool" && (item.kind == "complete" || item.kind == "result"))) &&
        byte_len(item.text) > timeline_inline_bytes();
}

flow large_chat_duplicate(item: Event, outcome: string) -> bool {
    return ((item.role == "main" && item.kind == "tool") ||
        (item.role == "tool" && (item.kind == "complete" || item.kind == "result"))) && item.text == outcome &&
        byte_len(item.text) > timeline_inline_bytes();
}

public flow chat_omitted() -> string { return "Large selected tool outcome retained by canonical chat state and archived by turn before a later turn; duplicate timeline text omitted."; }

flow context_omitted() -> string { return "Large prior tool outcome retained by canonical turn evidence; duplicate child context text omitted."; }

flow work_omitted() -> string { return "Large selected tool outcome retained in canonical work evidence; duplicate timeline text omitted."; }

// A completed child record repeats the previous turn's selected outcome as a
// user/context/outcome event. It is not part of conversation(); the canonical
// main/tool event is restored from the per-turn evidence row instead. Compact
// every outgoing frame so sessions written by earlier versions are repaired on
// their next reserve/finish without changing the durable schema or CAS head.
flow compact_context_duplicates(value: Frame, policy: Policy, binding: string) -> Result<Frame, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let marker = match encode(context_omitted(), policy) { Ok(item) => item.value, Err(error) => { return Err(error); } };
    var events: Array<Event> = []; var chat_turn: i32 = 0;
    @limits([Iterations(4096)]) for item in value.events.events {
        if item.role == "system" && item.kind == "native-budget" &&
            (item.name == "chat" || item.name == "chat-large" || item.name == "chat-resilient" || item.name == "chat-high-input" || item.name == "chat-full") {
            chat_turn = chat_turn + 1;
        }
        let duplicate = item.role == "user" && item.kind == "context" && item.name == "outcome" &&
            byte_len(item.text) > timeline_inline_bytes();
        var compact = false;
        if duplicate && chat_turn >= 2 {
            let decoded = match decode(item.text, policy) { Ok(text) => text, Err(error) => { return Err(error); } };
            match load_evidence(chat_turn - 1, policy, binding) {
                Ok(Some(evidence)) => { compact = evidence == decoded; }
                Ok(None()) => (),
                Err(error) => { return Err(error); }
            }
        }
        events = events.push(item { text = if compact { marker } else { item.text } });
    }
    let before = value.events;
    return Ok(value { events = before { events } });
}

flow evidence_error(value: Evidence, policy: Policy, binding: string) -> string {
    let bound = binding_error(binding); if bound != "" { return bound; }
    if value.format != 1 || value.policy_binding != binding || value.turn < 1 || value.turn > 48 { return "invalid recoverable chat evidence identity"; }
    return match decode(value.text, policy) { Ok(_) => "", Err(error) => error };
}

public flow load_evidence(turn: i32, policy: Policy, binding: string) -> Result<Option<string>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if turn < 1 || turn > 48 { return Err("invalid recoverable chat evidence turn"); }
    let key = from_i32(turn); let entry = EvidenceFrames.Rows.get_entry(key);
    return match entry {
        None() => Ok(None()),
        Some(item) => {
            if item.key != key { return Err("recoverable chat evidence key mismatch"); }
            let value = item.value;
            let problem = evidence_error(value, policy, binding); if problem != "" { return Err(problem); }
            match decode(value.text, policy) { Ok(decoded) => Ok(Some(decoded)), Err(error) => Err(error) }
        }
    };
}

// Restore the durable conversation projection, including large tool evidence
// archived outside the compact main frame. The caller also supplies the latest
// canonical selection separately, so replace only its exact projected copies
// with explicit references. Earlier turns and non-selected work/check events
// stay in their original order, including their positions around the references.
public flow conversation(frame: EventFrame, latest: Previous, policy: Policy, binding: string) -> Result<Array<Event>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    var selected: Array<Event> = []; var chat_turn: i32 = 0; var chat_open = false;
    @limits([Iterations(4096)]) for event in frame.events {
        if event.role == "system" && event.kind == "native-budget" &&
            (event.name == "chat" || event.name == "chat-large" || event.name == "chat-resilient" || event.name == "chat-high-input" || event.name == "chat-full") {
            chat_turn = chat_turn + 1; chat_open = true;
        }
        if event.role == "system" && event.kind == "work-boundary" { chat_open = false; }
        if (event.role == "user" && event.kind == "request") || (event.role == "model" && event.kind == "request") ||
            (event.role == "tool" && event.kind == "check") || (event.role == "system" && (event.kind == "work-boundary" || event.kind == "notice")) ||
            (event.role == "assistant" && event.kind == "answer") ||
            (event.role == "main" && (event.kind == "consume" || event.kind == "tool" || event.kind == "answer")) {
            var value = match decode(event.text, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
            if event.role == "main" && event.kind == "tool" && value == chat_omitted() {
                if chat_turn < frame.turns {
                    value = match load_evidence(chat_turn, policy, binding) {
                        Ok(Some(item)) => item, Ok(None()) => { return Err("archived recoverable chat evidence missing"); }
                        Err(error) => { return Err(error); }
                    };
                } else {
                    if chat_turn != frame.turns || latest.tool == "" || latest.outcome == "" { return Err("latest recoverable chat evidence missing"); }
                    value = latest.outcome;
                }
            }
            if chat_open && chat_turn == frame.turns && event.role == "main" && event.kind == "tool" && latest.tool != "" && event.name == latest.tool &&
                latest.outcome != "" && value == latest.outcome && byte_len(value) > timeline_inline_bytes() {
                value = "Exact latest tool outcome supplied separately as current.prior.outcome for read stages or previous.outcome for work stages; duplicate text omitted.";
            }
            selected = selected.push(event { text = value });
        }
    }
    return Ok(selected);
}

flow archive_evidence(turn: i32, outcome: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if byte_len(outcome) <= timeline_inline_bytes() { return Ok(false); }
    let text = match encode(outcome, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
    let value = Evidence { format = 1, policy_binding = binding, turn, text };
    let problem = evidence_error(value, policy, binding); if problem != "" { return Err(problem); }
    let key = from_i32(turn);
    match EvidenceFrames.Rows.get_entry(key) {
        Some(item) => {
            if item.key != key { return Err("recoverable chat evidence changed; no retry"); }
            let old = item.value;
            if old.format != 1 || old.policy_binding != binding || old.turn != turn || old.text != text {
                return Err("recoverable chat evidence changed; no retry");
            }
            return Ok(false);
        }
        None() => (),
    }
    let target = Target { store = ["Rows"], region = "nomo-recoverable-chat-evidence-v1", key, label = "recoverable chat evidence" };
    return match commit_native(EvidenceFrames.Rows, target, value, Missing) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

flow frame_error(value: Frame, policy: Policy, binding: string) -> string {
    let bound = binding_error(binding); if bound != "" { return bound; }
    if value.format != 1 || value.encoding != "json-string-v1" || value.policy_binding != binding { return "invalid recoverable chat format, encoding or policy binding"; }
    let chat_error = invalid_chat(value.chat); if chat_error != "" { return chat_error; }
    let event_error = invalid_events(value.events, policy); if event_error != "" { return event_error; }
    @limits([Iterations(4096)]) for item in value.events.events {
        match decode(item.text, policy) { Ok(_) => (), Err(error) => { return error; } }
    }
    if value.chat.invocation.admitted != value.events.turns { return "chat and event turns differ"; }
    let prior = value.chat.invocation.prior;
    @limits([Iterations(7)]) for field in [value.chat.last_request, value.chat.pending, prior.task, prior.result, prior.tool, prior.outcome, prior.answer] {
        let checked = match redact(field, policy) { Ok(item) => item, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "chat contains a known sensitive literal"; }
    }
    return "";
}

// Values reaching write() are assembled from a previously validated frame and
// text returned by event_text_codec.encode in the same call. Preserve all
// identity, ledger, redaction and aggregate bounds without reparsing every
// encoded event before it is stored. load() remains the trust boundary
// and performs the full canonical frame_error validation.
flow constructed_frame_error(value: Frame, policy: Policy, binding: string) -> string {
    let bound = binding_error(binding); if bound != "" { return bound; }
    if value.format != 1 || value.encoding != "json-string-v1" || value.policy_binding != binding { return "invalid recoverable chat format, encoding or policy binding"; }
    let chat_error = invalid_chat(value.chat); if chat_error != "" { return chat_error; }
    let event_error = event_shape_error(value.events, policy); if event_error != "" { return event_error; }
    if value.chat.invocation.admitted != value.events.turns { return "chat and event turns differ"; }
    let prior = value.chat.invocation.prior;
    @limits([Iterations(7)]) for field in [value.chat.last_request, value.chat.pending, prior.task, prior.result, prior.tool, prior.outcome, prior.answer] {
        let checked = match redact(field, policy) { Ok(item) => item, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "chat contains a known sensitive literal"; }
    }
    return "";
}

public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let problem = policy_error(policy); if problem != "" { return Err(problem); }
    let invalid = binding_error(binding); if invalid != "" { return Err(invalid); }
    let entry = Frames.Rows.get_entry("latest");
    return match entry {
        Some(item) => {
            if item.key != "latest" { return Err("recoverable chat key mismatch"); }
            let error = frame_error(item.value, policy, binding); if error != "" { return Err(error); }
            Ok(Some(item))
        }
        None() => Ok(None())
    };
}

flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryEntry<string, Frame>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let compact = match compact_context_duplicates(value, policy, binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    let desired = compact { format = 1 };
    let error = constructed_frame_error(desired, policy, binding); if error != "" { return Err(error); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let target = Target { store = ["Rows"], region = "nomo-recoverable-chat-v1", key = "latest", label = "recoverable chat" };
    let version = match commit_native(Frames.Rows, target, desired, condition) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    // commit_native already performs exact raw stored-value and version
    // readback. Do not immediately reload and parse the same MiB-scale frame.
    match expected { Some(item) => if item.version.opaque == version.opaque { return Err("recoverable chat version did not change"); }, None() => (), }
    return Ok(MemoryEntry { key = "latest", value = desired, version });
}

public flow matches_version(expected: MemoryVersion) -> Result<bool, string> ![Memory, Error<StorageError>] {
    return match Frames.Rows.get_entry("latest") {
        Some(item) => Ok(item.key == "latest" && item.version.opaque == expected.opaque),
        None() => Ok(false),
    };
}

public flow create(policy: Policy, binding: string, high_input: bool) -> Result<MemoryEntry<string, Frame>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return write(Frame { format = 1, encoding = "json-string-v1", policy_binding = binding, chat = if high_input { fresh_high_input_events() } else { fresh_events() }, events = empty_events() }, None(), policy, binding);
}

public flow reserve(expected: MemoryEntry<string, Frame>, request: string, policy: Policy, binding: string) -> Result<MemoryEntry<string, Frame>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(expected.value, policy, binding); if error != "" { return Err(error); }
    let saved = expected.value.chat;
    if saved.invocation.prior.tool != "" {
        match archive_evidence(saved.invocation.admitted, saved.invocation.prior.outcome, policy, binding) { Ok(_) => (), Err(problem) => { return Err(problem); } }
    }
    let current = if saved.format == 3 && saved.phase == "complete" { match extend(saved) { Ok(item) => item, Err(problem) => { return Err(problem); } } } else { saved };
    let pending = match begin(current, request) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    let marker = match encode(if saved.format == 19 { "Reserved up to 786432 output tokens and 6291456 configured native tokens for this chat turn; every model call reserves 131072 output tokens including reasoning; actual usage is unknown." } else { if saved.format == 18 { "High-input mode reserves up to 81920 output tokens and 3786432 configured native tokens for this chat turn; child model calls reserve 16384 output tokens each; provider input and output share its context window; actual usage is unknown." } else { if saved.format == 17 { "High-input mode reserves up to 32768 output tokens and 3786432 configured native tokens for this chat turn; provider input and output share its context window; actual usage is unknown." } else { if saved.format == 16 { "Reserved up to 3786432 configured native tokens for this chat turn; actual usage is unknown." } else { if saved.format == 15 { "Reserved up to 3048576 configured native tokens for this chat turn; actual usage is unknown." } else { "Reserved up to 1179648 configured native tokens for this chat turn; actual usage is unknown." } } } } }, policy) { Ok(item) => item.value, Err(problem) => { return Err(problem); } };
    let prior = expected.value.events;
    let events = prior {
        format = 2,
        events = prior.events.push(Event { role = "system", kind = "native-budget", name = if saved.format == 19 { "chat-full" } else { if saved.format == 17 || saved.format == 18 { "chat-high-input" } else { if saved.format == 16 { "chat-resilient" } else { if saved.format == 15 { "chat-large" } else { "chat" } } } }, text = marker })
    };
    return write(Frame { format = 1, encoding = "json-string-v1", policy_binding = binding, chat = pending, events }, Some(expected), policy, binding);
}

public flow finish(expected: MemoryEntry<string, Frame>, result: TurnResult, policy: Policy, binding: string) -> Result<MemoryEntry<string, Frame>, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = frame_error(expected.value, policy, binding); if error != "" { return Err(error); }
    let completed = match result.completed { Some(item) => item, None() => { return Err("completed event batch missing"); } };
    let chat = match complete(expected.value.chat, result) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if completed.records.len() == 0 || completed.records.len() > 24 { return Err("invalid completed event batch"); }
    var encoded: Array<Event> = [];
    @limits([Iterations(24)]) for item in completed.records {
        // Only text exactly equal to the selected outcome is duplicated by
        // chat.invocation.prior.outcome. Preserve non-selected child tool
        // records: a multi-tool chat has no other canonical store for them.
        let text = match encode(if large_chat_duplicate(item, chat.invocation.prior.outcome) { chat_omitted() } else { item.text }, policy) { Ok(value) => value.value, Err(problem) => { return Err(problem); } };
        // The shared legacy read controller used the literal "qwen" for a
        // generic model-text event, including under MiniMax. Do not persist it
        // as a provider identity in the provider-independent record.
        let name = if item.role == "model" && item.kind == "text" && item.name == "qwen" { "" } else { item.name };
        encoded = encoded.push(item { name, text });
    }
    let events = match append_encoded(expected.value.events, chat.invocation.admitted, encoded, policy) {
        Ok(item) => item.frame, Err(problem) => { return Err(problem); }
    };
    return write(Frame { format = 1, encoding = "json-string-v1", policy_binding = binding, chat, events }, Some(expected), policy, binding);
}

// Work facts commit separately; only a confirmed subsequent copy enters this order.
// Callers which already crossed the load() trust boundary retain that exact CAS
// entry through their work transaction instead of inflating the chat again.
public flow record_work_from(before: MemoryEntry<string, Frame>, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if before.value.chat.phase == "running" { return Err("chat turn unresolved"); }
    var timeline_records: Array<Event> = [];
    @limits([Iterations(24)]) for item in records {
        timeline_records = timeline_records.push(item { text = if large_work_duplicate(item) { work_omitted() } else { item.text } });
    }
    let batch = match work_batch(timeline_records, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let marker = match encode("Recorded completed work; selected facts follow.", policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
    let previous = before.value.events; var ordered = previous.events.push(Event { role = "system", kind = "work-boundary", name = id, text = marker });
    @limits([Iterations(24)]) for item in batch.events { ordered = ordered.push(item); }
    let events = previous { format = 2, events = ordered };
    let frame = before.value { events };
    return match write(frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

public flow record_work(id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match load(policy, binding) { Ok(Some(value)) => value, _ => { return Err("existing recoverable session required"); } };
    return record_work_from(before, id, records, policy, binding);
}

// Record a completed independent check as its own event, without a work/edit row.
public flow record_check(id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, independent: bool, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let bad = invalid_values(1, "complete", id, digest, outcome, exit_code, false); if bad != "" { return Err(bad); }
    let before = match load(policy, binding) { Ok(Some(value)) => value, _ => { return Err("existing recoverable session required"); } };
    if before.value.chat.phase == "running" { return Err("chat turn unresolved"); }
    let out = match encode_prefix(stdout, out_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let err = match encode_prefix(stderr, err_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let plain_out = match decode(out.value, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let plain_err = match decode(err.value, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let text = "Recorded check " + id + " (command digest " + digest + "); workspace may have changed since. Outcome " + outcome + ". Exit " + exit_code + "\nstdout: " + plain_out + "\nstderr: " + plain_err + "\nSome output may be omitted or truncated: " + if out.truncated || err.truncated { "yes" } else { "no" };
    let encoded = match encode(text, policy) { Ok(item) => item.value, Err(error) => { return Err(error); } };
    let previous = before.value.events;
    let events = previous {
        format = 2,
        events = previous.events.push(Event { role = "tool", kind = "check", name = if independent { "independent-check" } else { "work-check" }, text = encoded })
    };
    let frame = before.value { events };
    return match write(frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
