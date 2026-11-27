module nomo.application.sessions.history_work;

import std.memory.{WriteCondition, MemoryVersion, Missing};
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.application.sessions.ports.prior_chat.PriorChatReader;
import nomo.application.sessions.persistence.commit_once;
import nomo.domain.sessions.chat_history.Entry;
import nomo.domain.sessions.history_work_guard.{Ticket, full, zero, invalid};
import nomo.session.history_work_guard.Record;
import nomo.harness.harness_work_contract.Ledger;

flow history_error<S ~ PriorChatReader>(source: S, history: Entry) -> string {
    if history.key != "latest" || history.value.invocation.admitted < 1 || history.value.phase == "running" || history.value.pending != "" {
        return "a completed prior chat turn is required";
    }
    let actual = match source.load() { Ok(Some(value)) => value, _ => { return "chat history missing or invalid"; } };
    if actual != history { return "chat history changed; no retry"; }
    return "";
}

flow write<S ~ CasRows<Record>>(rows: S, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> {
    let error = invalid(row); if error != "" { return Err(error); }
    return commit_once<Record, S>(rows, row, condition, None());
}

public flow admit<S ~ CasRows<Record> + PriorChatReader>(source: S, id: string, workspace: string, path: string, request: string, history: Entry) -> Result<Ticket, string> {
    let before = match source.read() { Ok(value) => value, Err(error) => { return Err(error); } };
    if before != None() { return Err("history-work already admitted; no retry"); }
    let error = history_error(source, history); if error != "" { return Err(error); }
    let row = Record { format = 1, phase = "running", id, workspace, path,
        request, history_version = history.version.opaque, reserved = full(), settled = None(), summary = "" };
    let version = match write(source, row, Missing) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    return Ok(Ticket { record = row, version, history });
}

public flow claim<S ~ CasRows<Record> + PriorChatReader>(source: S, ticket: Ticket) -> Result<bool, string> {
    let error = invalid(ticket.record); if error != "" { return Err(error); }
    let history = history_error(source, ticket.history); if history != "" { return Err(history); }
    if ticket.record.phase != "running" || ticket.record.history_version != ticket.history.version.opaque { return Err("history-work ticket changed"); }
    let actual = match source.read() { Ok(Some(value)) => value, Ok(None()) => { return Err("history-work reservation missing"); } Err(error) => { return Err(error); } };
    if actual.key != "work" || actual.value != ticket.record || actual.version.opaque != ticket.version.opaque { return Err("history-work reservation changed; no retry"); }
    return Ok(true);
}

public flow finish<S ~ CasRows<Record> + PriorChatReader>(source: S, ticket: Ticket, summary: string, spent: Ledger) -> Result<bool, string> {
    match claim(source, ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    let old = ticket.record;
    let row = old { format = 1, phase = "complete", reserved = zero(), settled = Some(spent), summary };
    let version = match write(source, row, WriteCondition.Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("history-work version did not change"); }
    return Ok(true);
}

public flow chat_available<S ~ CasRows<Record>>(rows: S) -> Result<bool, string> {
    return match rows.read() { Ok(None()) => Ok(true), Ok(Some(_)) => Err("history-work consumes this session; no chat continuation"), Err(error) => Err(error) };
}

// Status is data only; it is never a current root observation or a grant.
public flow inspect<S ~ CasRows<Record>>(rows: S) -> Result<Option<Record>, string> {
    let before = match rows.read() { Ok(value) => value, Err(error) => { return Err(error); } };
    match before {
        None() => { return Ok(None()); }
        Some(value) => {
            let error = invalid(value.value); if error != "" { return Err(error); }
            if value.key != "work" { return Err("history-work status key mismatch"); }
            let after = match rows.read() { Ok(value) => value, Err(error) => { return Err(error); } };
            if after != before { return Err("history-work changed during status"); }
            return Ok(Some(value.value));
        }
    }
}
