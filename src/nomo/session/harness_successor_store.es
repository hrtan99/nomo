module nomo.session.harness_successor_store;

import nomo.session.cas_rows.{Target, commit_native};

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry, Missing, Match};
import nomo.model.model_tool_contract.question_error;
import nomo.session.harness_checkpoint.{Identity, identity_error};
import nomo.session.harness_checkpoint_store.{Binding, binding};
import nomo.session.harness_successor.{Successor, restore, validate, encode, decode};
import nomo.harness.harness_tool_contract.{Ledger, ledger_error};
import nomo.harness.harness_tool_chat_contract.{TurnResult, Context, context_error, combine, empty};

public type Record = { format: i32, phase: string, predecessor: Identity, successor: Identity,
    predecessor_version: string, predecessor_body: string, request: string, body: string,
    usage: Ledger, maximum: Ledger, reserved: Ledger, admitted: i32, resolved: bool };
public type Ticket = { predecessor: Binding, successor: Identity, request: string, version: MemoryVersion };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Successors = std.memory.region<Schema>(stable_id = "nomo-harness-successor-v1", store = "harness-successor");

flow admission(identity: Identity) -> string { return "admission:" + identity.id; }
flow key(identity: Identity) -> string { return "successor:" + identity.id; }
flow read(name: string) -> Option<MemoryEntry<string, Record>> { return get_entry(Successors.Rows, name); }

flow write(name: string, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return commit_native<Record>(Successors.Rows, Target { store = ["Rows"], region = "nomo-harness-successor-v1", key = name, label = "successor" }, row, condition);
}

flow row(ticket: Ticket, phase: string, body: string, usage: Ledger, resolved: bool) -> Record {
    let before = ticket.predecessor;
    let reserved = if resolved { Ledger { steps = 0, calls = 0, tokens = 0, tools = 0, scan = 0 } }
        else { Ledger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    return Record { format = 1, phase = phase, predecessor = before.checkpoint.identity, successor = ticket.successor,
        predecessor_version = before.version.opaque, predecessor_body = before.body, request = ticket.request,
        body = body, usage = usage, maximum = before.checkpoint.maximum, reserved = reserved, admitted = 2, resolved = resolved };
}

flow unchanged(before: Binding) -> string {
    let after = match binding(before.checkpoint.identity) { Ok(value) => value, Err(error) => { return error; } };
    if before != after { return "predecessor version or body changed; no retry"; }
    return "";
}

flow claim(ticket: Ticket) -> Result<MemoryEntry<string, Record>, string> {
    let before = match read(admission(ticket.predecessor.checkpoint.identity)) { Some(value) => value,
        None() => { return Err("continuation admission missing; no retry"); } };
    let expected = row(ticket, "admitted", "", ticket.predecessor.checkpoint.usage, false);
    if before.value != expected || before.version.opaque != ticket.version.opaque {
        return Err("continuation admission or version changed; no retry");
    }
    return Ok(before);
}

// Missing-only admission is never deleted/reset. Its exact durable readback and
// the unchanged predecessor must both be confirmed before any Model/File call.
public flow admit(predecessor: Identity, successor: Identity, request: string) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let invalid = identity_error(successor); if invalid != "" { return Err(invalid); }
    if predecessor.id == successor.id || predecessor.workspace != successor.workspace || predecessor.allowed != successor.allowed {
        return Err("successor lineage or workspace binding mismatch");
    }
    let invalid_request = question_error(request); if invalid_request != "" { return Err(invalid_request); }
    let before = match binding(predecessor) { Ok(value) => value, Err(error) => { return Err(error); } };
    let restored = match restore(before.checkpoint) { Ok(value) => value, Err(error) => { return Err(error); } };
    let plan = Context { phase = "plan", request = request, task = "", result = "", tool = "", outcome = "",
        allowed = predecessor.allowed, prior = restored.prior };
    let invalid_context = context_error(plan); if invalid_context != "" { return Err(invalid_context); }
    match read(admission(predecessor)) { Some(_) => { return Err("predecessor continuation already admitted; no retry"); } None() => {} }
    match read(key(successor)) { Some(_) => { return Err("successor row already exists; no retry"); } None() => {} }
    let initial = Ticket { predecessor = before, successor = successor, request = request, version = before.version };
    let version = match write(admission(predecessor), row(initial, "admitted", "", before.checkpoint.usage, false), Missing) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    let changed = unchanged(before); if changed != "" { return Err(changed); }
    return Ok(Ticket { predecessor = before, successor = successor, request = request, version = version });
}

// Only returned validated failures settle. Host abort/unresolved metadata leaves
// the already durable admitted row unresolved; neither path restores allowance.
public flow failed(ticket: Ticket, turn: TurnResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if turn.status == 0 || !turn.resolved || turn.completed != None() || turn.state.admitted != 2 ||
        turn.state.maximum != ticket.predecessor.checkpoint.maximum || turn.state.prior != empty() {
        return Err("unresolved or incoherent failed continuation; admission retained");
    }
    let used = turn.state.usage; let prior = ticket.predecessor.checkpoint.usage;
    let local = Ledger { steps = used.steps - prior.steps, calls = used.calls - prior.calls, tokens = used.tokens - prior.tokens,
        tools = used.tools - prior.tools, scan = used.scan - prior.scan };
    let invalid = ledger_error(local); if invalid != "" { return Err(invalid); }
    let total = match combine(prior, local, turn.state.maximum) { Ok(value) => value, Err(error) => { return Err(error); } };
    if total != used { return Err("failed continuation cumulative settlement mismatch"); }
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    return match write(admission(ticket.predecessor.checkpoint.identity), row(ticket, "failed", "", used, true), Match(ticket.version)) {
        Ok(_) => Ok(true), Err(error) => Err(error)
    };
}

public flow publish(ticket: Ticket, saved: Successor) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match validate(saved, ticket.successor, ticket.predecessor.checkpoint.identity) { Ok(_) => {} Err(error) => { return Err(error); } }
    if saved.predecessor != ticket.predecessor.checkpoint || saved.predecessor_version != ticket.predecessor.version.opaque ||
        saved.request != ticket.request { return Err("successor differs from admitted predecessor or request"); }
    let body = match encode(saved) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    let changed = unchanged(ticket.predecessor); if changed != "" { return Err(changed); }
    match read(key(ticket.successor)) { Some(_) => { return Err("successor already exists; no retry"); } None() => {} }
    match write(admission(ticket.predecessor.checkpoint.identity), row(ticket, "settled", body, saved.usage, true), Match(ticket.version)) {
        Ok(_) => {} Err(error) => { return Err(error); }
    }
    let version = match write(key(ticket.successor), row(ticket, "pending", body, saved.usage, true), Missing) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    let committed = match write(key(ticket.successor), row(ticket, "published", body, saved.usage, true), Match(version)) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if committed.opaque == version.opaque { return Err("successor publication version did not change"); }
    return Ok(true);
}

// Data-only show checks explicit lineage, exact admission/publication bodies and
// stable read versions. The SQLite Host may maintain its normal WAL/schema.
public flow reload(predecessor: Identity, successor: Identity) -> Result<Successor, string> {
    let before = match binding(predecessor) { Ok(value) => value, Err(error) => { return Err(error); } };
    let admitted = match read(admission(predecessor)) { Some(value) => value,
        None() => { return Err("successor admission missing"); } };
    let published = match read(key(successor)) { Some(value) => value,
        None() => { return Err("successor missing; no completed continuation"); } };
    let saved = match decode(published.value.body) { Ok(value) => value, Err(error) => { return Err(error); } };
    match validate(saved, successor, predecessor) { Ok(_) => {} Err(error) => { return Err(error); } }
    let ticket = Ticket { predecessor = before, successor = successor, request = saved.request, version = admitted.version };
    if saved.predecessor != before.checkpoint || saved.predecessor_version != before.version.opaque ||
        admitted.value != row(ticket, "settled", published.value.body, saved.usage, true) ||
        published.value != row(ticket, "published", published.value.body, saved.usage, true) {
        return Err("successor admission, publication or predecessor mismatch");
    }
    let admission_after = match read(admission(predecessor)) { Some(value) => value, None() => { return Err("admission disappeared"); } };
    let after = match read(key(successor)) { Some(value) => value, None() => { return Err("successor disappeared"); } };
    if admission_after != admitted || after != published { return Err("successor changed during show"); }
    let changed = unchanged(before); if changed != "" { return Err(changed); }
    return Ok(saved);
}
