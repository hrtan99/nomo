module nomo.application.sessions.history_followup;

import std.memory.{WriteCondition, MemoryVersion, Missing};
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.application.sessions.ports.prior_chat.PriorChatReader;
import nomo.application.sessions.ports.followup_predecessors.FollowupPredecessors;
import nomo.application.sessions.persistence.commit_once;
import nomo.domain.sessions.chat_history.Entry;
import nomo.domain.sessions.history_followup_guard.{Ticket, full, zero, invalid};
import nomo.session.history_followup_guard.{Record, Parent};
import nomo.harness.harness_work_contract.Ledger;

public flow parent<S ~ FollowupPredecessors>(source: S) -> Result<Parent, string> {
    let work = match source.work() { Ok(Some(value)) => value, _ => { return Err("completed first work required"); } };
    if work.phase != "complete" { return Err("first work is unresolved; inspect without retry"); }
    let edit = match source.edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed first edit required"); } };
    if edit.phase != "completed" { return Err("first edit is unresolved"); }
    let check = match source.check() { Ok(value) => value, Err(error) => { return Err(error); } };
    match check { Some(value) => { if value.phase != "complete" || value.id != work.id { return Err("first check is unresolved"); } }, None() => (), }
    return Ok(Parent { work, edit, check });
}

flow history_error<S ~ PriorChatReader>(source: S, history: Entry) -> string {
    if history.key != "latest" || history.value.invocation.admitted < 1 || history.value.phase == "running" || history.value.pending != "" { return "completed chat history required"; }
    let actual = match source.load() { Ok(Some(value)) => value, _ => { return "chat history missing or invalid"; } };
    if actual != history { return "chat history changed; no retry"; }
    return "";
}

flow write<S ~ CasRows<Record>>(source: S, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> {
    let error = invalid(row); if error != "" { return Err(error); }
    return commit_once<Record, S>(source, row, condition, None());
}

public flow admit<S ~ CasRows<Record> + PriorChatReader + FollowupPredecessors>(source: S, id: string, workspace: string, path: string, request: string, history: Entry) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let before = match source.read() { Ok(value) => value, Err(error) => { return Err(error); } };
    if before != None() { return Err("followup slot already consumed; no retry"); }
    let error = history_error(source, history); if error != "" { return Err(error); }
    let prior = match parent(source) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    let row = Record { format = 1, phase = "running", id, workspace, path, request,
        history_version = history.version.opaque, parent = prior, reserved = full(), settled = None(), summary = "" };
    let version = match write(source, row, Missing) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    return Ok(Ticket { record = row, version, history });
}

public flow claim<S ~ CasRows<Record> + PriorChatReader + FollowupPredecessors>(source: S, ticket: Ticket) -> Result<bool, string> {
    let error = invalid(ticket.record); if error != "" { return Err(error); }
    let h = history_error(source, ticket.history); if h != "" { return Err(h); }
    let prior = match parent(source) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    if prior != ticket.record.parent { return Err("first work changed; no retry"); }
    if ticket.record.phase != "running" || ticket.record.history_version != ticket.history.version.opaque { return Err("followup ticket changed"); }
    let actual = match source.read() { Ok(Some(value)) => value, Ok(None()) => { return Err("followup reservation missing"); } Err(error) => { return Err(error); } };
    if actual.key != "followup" || actual.value != ticket.record || actual.version.opaque != ticket.version.opaque { return Err("followup reservation changed; no retry"); }
    return Ok(true);
}

public flow finish<S ~ CasRows<Record> + PriorChatReader + FollowupPredecessors>(source: S, ticket: Ticket, summary: string, spent: Ledger) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    match claim(source, ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    let old = ticket.record;
    let row = old { format = 1, phase = "complete", reserved = zero(), settled = Some(spent), summary };
    let version = match write(source, row, WriteCondition.Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("followup version did not change"); }
    return Ok(true);
}

public flow inspect<S ~ CasRows<Record> + FollowupPredecessors>(source: S) -> Result<Option<Record>, string> {
    let before = match source.read() { Ok(value) => value, Err(error) => { return Err(error); } };
    match before {
        None() => { return Ok(None()); }
        Some(value) => {
            let error = invalid(value.value); if error != "" { return Err(error); }
            let prior = match parent(source) { Ok(item) => item, Err(problem) => { return Err(problem); } };
            if value.key != "followup" || value.value.parent != prior || (match source.read() { Ok(value) => value, Err(error) => { return Err(error); } }) != before { return Err("followup status changed or predecessor differs"); }
            return Ok(Some(value.value));
        }
    }
}
