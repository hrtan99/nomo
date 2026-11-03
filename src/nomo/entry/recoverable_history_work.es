module nomo.entry.recoverable_history_work;

import std.io.println;
import std.collections.len as count;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.{Work, parse};
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.harness_model_tools.work_child_turn;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.history_work_model.{read_main, plan, child, aggregate};
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.entry.harness_work_entry.{prepare, finish_edit, finish_summary, ledger, Pending, Failure, Completed, Summary};
import nomo.session.event_policy.{PolicyRoot, load as load_policy};
import nomo.session.chat_history.load as load_legacy;
import nomo.session.recoverable_chat_store.load as load_chat;
import nomo.session.recoverable_work_store.{admit, claim, finish};
import nomo.session.recoverable_check_store.{plan as plan_check, load as load_check};
import nomo.session.work_fact_events.capture;
import nomo.session.history_work_guard.inspect as inspect_legacy_work;
import nomo.session.history_check_guard.inspect as inspect_legacy_check;
import nomo.session.history_followup_guard.inspect as inspect_followup;
import nomo.session.history_followup_check_guard.inspect as inspect_followup_check;
import nomo.session.history_followup_edit_store.available as followup_edit_available;
import nomo.session.edit_operation_store.{available, begin, complete};
import nomo.entry.edit_coordinator.{Confirmed, confirm_current};
import nomo.entry.edit_context.display;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, apply};

flow stage(name: string, value: Ledger) -> unit { println("STAGE " + name); ledger(value); }
flow prepare_history(input: Work, prior_request: string, previous: Previous) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state);
    return prepare(input, original, log, false, false, false) with {
        LegacyStringStages.main(value) => { resume read_main(value, prior_request, previous); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume plan(value, prior_request, previous); }
        LegacyEditStages.child(value) => { resume child(value, prior_request, previous); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value, prior_request, previous); }
    };
}
flow summarize_history(value: Completed, prior_request: string, previous: Previous) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state);
    return finish_summary(value, log, false, false) with {
        LegacyEditStages.plan(item) => { resume plan(item, prior_request, previous); }
        LegacyEditStages.child(item) => { resume child(item, prior_request, previous); }
        LegacyEditStages.aggregate(item) => { resume aggregate(item, prior_request, previous); }
    };
}
flow refused(error: string) -> i32 { println("REFUSED " + error); return 1; }

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<PolicyRoot>, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) < 2 || args[count(args) - 2] != "--policy-binding" { return refused("event work requires a policy binding"); }
    let binding = args[count(args) - 1]; var work_args: Array<string> = []; var i: usize = 0;
    let has_check = count(args) >= 4 && args[count(args) - 4] == "--check-ref";
    let check_digest = if has_check { args[count(args) - 3] } else { "" };
    let end = if has_check { count(args) - 4 } else { count(args) - 2 };
    while i < end limit Iterations(32) { work_args = work_args.push(args[i]); i = i + 1; }
    let input = match parse(work_args) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.edit.help { return refused("select a current read root, private edit root, target and task"); }
    let policy = match load_policy() { Ok(value) => value, Err(error) => { return refused(error); } };
    match load_legacy() { Ok(None()) => {} _ => { return refused("legacy session cannot be migrated automatically"); } }
    match inspect_legacy_work() { Ok(None()) => {} _ => { return refused("legacy work exists or is invalid"); } }
    match inspect_legacy_check() { Ok(None()) => {} _ => { return refused("legacy check exists or is invalid"); } }
    match inspect_followup() { Ok(None()) => {} _ => { return refused("legacy followup exists or is invalid"); } }
    match inspect_followup_check() { Ok(None()) => {} _ => { return refused("legacy followup check exists or is invalid"); } }
    match followup_edit_available() { Ok(_) => {} _ => { return refused("legacy followup edit exists or is invalid"); } }
    match available() { Ok(_) => {} Err(error) => { return refused(error); } }
    let history = match load_chat(policy, binding) { Ok(Some(value)) => value, _ => { return refused("saved event chat missing or invalid"); } };
    match load_check(policy, binding) { Ok(None()) => {} _ => { return refused("check already exists or is invalid"); } }
    let ticket = match admit(input.edit.id, input.edit.workspace, input.edit.path, input.edit.request, history, policy, binding) {
        Ok(value) => value, Err(error) => { return refused(error); }
    };
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } }
    if has_check { match plan_check(ticket, check_digest, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } } }
    println("RESERVED event work; interruption or uncertain effects cannot be retried automatically.");
    let prior_request = history.value.chat.last_request; let previous = history.value.chat.invocation.prior;
    let pending = match prepare_history(input, prior_request, previous) { Ok(value) => value, Err(failure) => { ledger(failure.state); return refused(failure.error); } };
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(error); } };
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return refused(error); } }
    let intent = match begin(selected) { Ok(value) => value, Err(error) => { return refused(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => {} Err(error) => { return refused(error); } }
    match complete(intent) { Ok(_) => {} Err(error) => { return refused("edit may have completed; " + error); } }
    println("APPLIED " + selected.id);
    let confirmed = Confirmed { binding = selected, after = pending.prepared.proposal.after };
    println("POST_EDIT context");
    let completed = match finish_edit(pending, confirmed) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    println("POST_EDIT aggregate");
    let summary = match summarize_history(completed, prior_request, previous) { Ok(value) => value, Err(failure) => { return refused(failure.error); } };
    println("POST_EDIT events");
    let records = match capture(pending, confirmed, summary) { Ok(value) => value, Err(error) => { return refused("edit completed; " + error); } };
    println("POST_EDIT persist");
    match finish(ticket, summary.answer, summary.state, records, policy, binding) { Ok(_) => {} Err(error) => { return refused("edit completed; " + error); } }
    display("FINAL ", summary.answer); println("SAVED event work facts; no grant or root identity is persisted.");
    ledger(summary.state); return 0;
}
