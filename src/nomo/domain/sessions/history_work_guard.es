module nomo.domain.sessions.history_work_guard;

import std.memory.MemoryVersion;
import nomo.domain.sessions.chat_history.Entry;
import nomo.session.history_work_guard.{Budget, Record};
import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.harness.read_protocol.question_error;
import nomo.domain.harness.harness_edit_contract.history_summary_error;
import std.text.char_count as len;
import nomo.domain.harness.harness_work_contract.{ledger_error, native_tokens, native_budget};
import nomo.domain.context.large_context.compatible_scan_i32;

public type Ticket = { record: Record, version: MemoryVersion, history: Entry };

public flow full() -> Budget { return Budget { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }

public flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }

public flow generation(format: i32) -> i32 {
    return if format == 1 { 47104 } else { if format == 7 || format == 8 { 286720 } else { if format == 10 { 917504 } else { if format == 6 || format == 9 { 188416 } else { if format == 3 || format == 4 { 61440 } else { 51200 } } } } };
}

flow configured_native(format: i32) -> i32 {
    return if format == 10 { 7340032 } else { if format == 9 { 6000000 } else { if format == 7 || format == 8 { 2811008 } else { if format == 6 { 2073152 } else { if format >= 4 { 1335296 } else { 196608 } } } } };
}

// Ledger fields preserve the configured stage-shape accounting used by older
// records. Format 9 stores its 6M run ceiling in Record.reserved/format; neither
// number is actual provider usage.
flow settled_shape_native(format: i32) -> i32 { return if format == 9 { 2073152 } else { configured_native(format) }; }

flow expected_scan(format: i32, value: i32) -> bool { return if format == 8 || format == 9 || format == 10 { compatible_scan_i32(value) } else { value == 65540 }; }

public flow invalid(value: Record) -> string {
    if (value.format < 1 || value.format > 10) || (value.phase != "running" && value.phase != "complete" && value.phase != "abandoned") { return "invalid history-work phase"; }
    let selected = selector_error(value.id, value.workspace, value.path); if selected != "" { return selected; }
    let question = question_error(value.request); if question != "" { return question; }
    if value.history_version == "" || len(value.history_version) > 512 { return "invalid history version"; }
    if value.phase == "running" || value.phase == "abandoned" {
        let expected = if value.format == 1 { full() } else { Budget { steps = 13, calls = 7, generation = generation(value.format), native_tokens = configured_native(value.format) } };
        if value.summary != "" || value.reserved != expected || value.settled != None() { return "invalid running work reservation"; }
    } else {
        if history_summary_error(value.summary, "summary") != "" || value.reserved != zero() { return "invalid completed work summary or reservation"; }
        let spent = match value.settled { Some(item) => item, None() => { return "missing settled work ledger"; } };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls + spent.edit.calls != 7 ||
            spent.read.tokens + spent.edit.tokens != generation(value.format) || (if value.format >= 4 { native_budget(spent) != settled_shape_native(value.format) || !expected_scan(value.format, spent.read.scan) } else { native_tokens(spent) != 196608 }) { return "invalid settled work ledger"; }
    }
    return "";
}
