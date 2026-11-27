module nomo.domain.sessions.recoverable_work_state;

import std.memory.MemoryEntry;
import nomo.domain.sessions.redaction.{Policy, text as redact};
import nomo.domain.sessions.event_text_codec.decode;
import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.domain.sessions.recoverable_events.invalid as invalid_events;
import nomo.session.recoverable_chat_store.Frame as ChatFrame;
import nomo.session.history_work_guard.{Record, Budget};
import nomo.domain.sessions.history_work_guard.invalid as invalid_work;
import nomo.harness.harness_work_contract.Ledger;

public flow full(wide: bool) -> Budget { return Budget { steps = 13, calls = 7, generation = if wide { 286720 } else { 51200 }, native_tokens = if wide { 2811008 } else { 1335296 } }; }

public flow full_mode(wide: bool, high_input: bool) -> Budget { return if high_input { Budget { steps = 13, calls = 7, generation = 917504, native_tokens = 7340032 } } else { full(wide) }; }

public flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }

public flow running_record(id: string, workspace: string, path: string, request: string, history_version: string, wide: bool) -> Record {
    return Record { format = if wide { 8 } else { 5 }, phase = "running", id, workspace, path,
        request, history_version, reserved = full(wide), settled = None(), summary = "" };
}

public flow running_record_mode(id: string, workspace: string, path: string, request: string, history_version: string, wide: bool, high_input: bool) -> Record {
    return Record { format = if high_input { 10 } else { if wide { 8 } else { 5 } }, phase = "running", id, workspace, path,
        request, history_version, reserved = full_mode(wide, high_input), settled = None(), summary = "" };
}

public flow completed_record(old: Record, summary: string, spent: Ledger) -> Record {
    return old { phase = "complete", reserved = zero(), settled = Some(spent), summary };
}

public flow abandoned_record(old: Record, id: string, label: string) -> Result<Record, string> {
    if old.id != id || old.phase != "running" { return Err("interrupted " + label + " identity or phase differs"); }
    return Ok(old { phase = "abandoned" });
}

public flow admission_chat_error(current: MemoryEntry<string, ChatFrame>, expected: MemoryEntry<string, ChatFrame>) -> string {
    if current != expected || expected.value.chat.invocation.admitted < 1 || expected.value.chat.phase == "running" || expected.value.chat.pending != "" { return "completed unchanged recoverable chat required"; }
    return "";
}

public flow claim_chat_error(current: MemoryEntry<string, ChatFrame>, expected: MemoryEntry<string, ChatFrame>, work: Record, label: string) -> string {
    if current != expected || work.history_version != current.version.opaque || work.phase != "running" { return label + " chat binding changed; no retry"; }
    return "";
}

public flow work_data_error(work: Record, events: EventFrame, policy: Policy) -> string {
    let work_error = invalid_work(work); if work_error != "" { return work_error; }
    let event_error = invalid_events(events, policy); if event_error != "" { return event_error; }
    if ((work.phase == "running" || work.phase == "abandoned") && events.turns != 0) || (work.phase == "complete" && events.turns != 1) {
        return "work phase and event boundary differ";
    }
    @limits([Iterations(5)]) for field in [work.id, work.workspace, work.path, work.request, work.summary] {
        let checked = match redact(field, policy) { Ok(item) => item, Err(error) => { return error; } };
        if checked.replacements != 0 || checked.value != field { return "work data contains a known sensitive literal"; }
    }
    @limits([Iterations(48)]) for item in events.events {
        match decode(item.text, policy) { Ok(_) => (), Err(error) => { return error; } }
    }
    return "";
}
