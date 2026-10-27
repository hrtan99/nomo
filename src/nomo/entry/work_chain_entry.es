module nomo.entry.work_chain_entry;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply};
import nomo.tools.edit_encoding.{json, object};
import nomo.tools.edit_binding.bind;
import nomo.cli.work_chain_args.parse;
import nomo.cli.edit_args.parse as selectors;
import nomo.harness.harness_work_contract.{Ledger, fresh};
import nomo.harness.work_chain_model.{ParentFacts, parent_facts};
import nomo.session.work_record.{partial, admit, validate as captured};
import nomo.session.work_chain.{Record, publish_partial as projected, linked};
import nomo.session.work_chain_store.{Ticket, read_parent, admit_new, admit_continue, claim, publish_partial, complete, inspect};
import nomo.session.work_chain_journal.{begin, complete as complete_edit, inspect as journal};
import nomo.entry.edit_coordinator.{Approval, Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.entry.harness_work_entry.{Pending, prepare_chain_work, completed_context_work, summarize_chain, chain_ledger as ledger};
import nomo.entry.work_chain_display.render;

flow refused(state: Ledger, error: string) -> i32 { println("REFUSED " + error); ledger(state); return 1; }

flow execute(ticket: Ticket, pending: Pending) -> Result<Confirmed, string> {
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    let intent = match begin(ticket.row.chain, ticket.row.turn, selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return Err(error); } }
    match complete_edit(intent) { Ok(_) => {} Err(error) => { return Err(error); } }
    println("APPLIED " + selected.id);
    return Ok(Confirmed { binding = selected, after = pending.prepared.proposal.after });
}
flow run(args: Array<string>, continuing: bool) -> i32 {
    let input = match parse(args, continuing) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if input.work.edit.help {
        println("chain_new or chain_continue --parent ROOT: work selectors and optional --cap steps,calls,generation,native,read,scan,edit_reads,edit_bytes,atomic,atomic_bytes; canonical bounded counters, current confirmation each turn."); return 0;
    }
    let edit = input.work.edit; var prior: Array<ParentFacts> = []; var expected: Option<string> = None();
    var selected_ticket: Option<Ticket> = None();
    if continuing {
        let parent = match read_parent(input.parent, edit.workspace, edit.path) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
        prior = match parent_facts(parent.value) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
        let parent_work = match parent.value.work { Some(value) => value, None() => { return refused(fresh(), "confirmed parent work missing"); } };
        let previous = match captured(parent_work) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
        expected = Some(previous.after);
        let saved = match admit_continue(input.parent, edit.id, edit.workspace, edit.path, edit.request, input.work.allowed, input.cap, parent) {
            Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
        selected_ticket = Some(saved);
    } else {
        let saved = match admit_new(edit.id, edit.workspace, edit.path, edit.request, input.work.allowed, input.cap) {
            Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
        selected_ticket = Some(saved);
    }
    let ticket = match selected_ticket { Some(value) => value, None() => { return refused(fresh(), "v2 admission unavailable"); } };
    println("ADMITTED v2 complete turn reservation durable; lifetime26 steps/14 calls/94208 generation/393216 native/2 atomic attempts; configured allowances, no automatic retry or refund.");
    let pending = match prepare_chain_work(input.work, prior, expected) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let selected = pending.selected;
    let binding = match bind(selected.id, selected.workspace, selected.path, pending.prepared) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    let candidate = match partial(binding, pending.evidence, pending.task, pending.prepared) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    match admit(candidate) { Ok(_) => {} Err(error) => { return refused(pending.state, error); } }
    let projection = match projected(ticket.row, candidate) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    match ticket.parent { Some(parent) => { let error = linked(parent.value, parent.version.opaque, projection); if error != "" { return refused(pending.state, error); } } None() => {} }
    let outcome = match execute(ticket, pending) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    println("EDIT completed " + edit.id + "; v2 journal is authoritative; no replay or rollback.");
    match json(["chain_show", "--id", edit.id, "--workspace", edit.workspace, "--path", edit.path]) { Ok(value) => { println("NEXT " + value); } Err(_) => {} }
    let completed = match completed_context_work(pending, outcome) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    if outcome.binding != candidate.binding || outcome.after != pending.prepared.proposal.after { return refused(completed.state, "edit completed; v2 snapshot binding mismatch"); }
    println("WORK pending; edit completed; v2 snapshot not confirmed saved.");
    let saved = match publish_partial(ticket, candidate) { Ok(value) => value, Err(error) => { return refused(completed.state, "edit completed; " + error); } };
    println("WORK durable summary-unconfirmed; final reservation may have been attempted; cannot resume an uncertain turn.");
    let summary = match summarize_chain(completed, prior) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    match complete(saved, summary.answer) { Ok(_) => {} Err(error) => { return refused(summary.state, "edit completed; " + error); } }
    println("SAVED v2 summary-confirmed; cumulative lifetime reservation retained."); display("FINAL ", summary.answer); ledger(summary.state); return 0;
}
public flow run_new(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run(args, false); }
public flow run_continue(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run(args, true); }
public flow run_show(args: Array<string>) -> i32 {
    let input = match selectors(args, false) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    if input.help { println("chain_show --id ID --workspace BIND --path FILE; captured v2 admission/journal/work only."); return 0; }
    let row = match inspect(input.id, input.workspace, input.path) { Ok(Some(value)) => value, Ok(None()) => { println("CHAIN missing; missing data never establishes no edit occurred."); return 0; } Err(error) => { println("REFUSED " + error); return 1; } };
    let operation = match journal(row.chain, row.turn, row.id, row.workspace, row.path) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let lines = match render(row, operation) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    for line in lines limit Iterations(16) { println(line); }
    println("Captured facts, not current File state. Admitted work may have an intent or completed edit without a work snapshot. No replay or refund; reservations are configured, not measured usage."); return 0;
}
