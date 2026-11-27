module nomo.domain.sessions.history_followup_guard;

import std.memory.MemoryVersion;
import nomo.domain.sessions.chat_history.Entry;
import nomo.session.history_followup_guard.{Record, Budget};
import std.text.char_count as len;
import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.harness.read_protocol.question_error;
import nomo.domain.harness.harness_edit_contract.history_summary_error;
import nomo.domain.harness.harness_work_contract.{ledger_error, native_tokens};

public type Ticket = { record: Record, version: MemoryVersion, history: Entry };

public flow full() -> Budget { return Budget { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }

public flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }

public flow invalid(row: Record) -> string {
    if row.format != 1 || (row.phase != "running" && row.phase != "complete") { return "invalid followup phase"; }
    let selected = selector_error(row.id, row.workspace, row.path); if selected != "" { return selected; }
    if row.id == row.parent.work.id { return "followup operation ID must differ"; }
    if question_error(row.request) != "" || row.history_version == "" || len(row.history_version) > 512 { return "invalid followup request or history"; }
    if row.phase == "running" {
        if row.summary != "" || row.reserved != full() || row.settled != None() { return "invalid followup reservation"; }
    } else {
        if history_summary_error(row.summary, "summary") != "" || row.reserved != zero() { return "invalid followup completion"; }
        let spent = match row.settled { Some(value) => value, None() => { return "missing followup ledger"; } };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls + spent.edit.calls != 7 ||
            spent.read.tokens + spent.edit.tokens != 47104 || native_tokens(spent) != 196608 { return "invalid followup ledger"; }
    }
    return "";
}
