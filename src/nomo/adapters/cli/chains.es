module nomo.adapters.cli.chains;

import nomo.adapters.cli.chain_input.{
    Command as chain_input_Command,
    WorkChainArgsInput,
    work_chain_args_parse,
    work_chain_selection_args_parse
};
import nomo.adapters.cli.console.display;
import nomo.adapters.cli.edit_input.{Input, Work, edit_args_parse};
import nomo.adapters.cli.editing.{confirm_current, render as editing_render};
import nomo.adapters.cli.harness.{
    chain_ledger,
    completed_context_work,
    prepare_chain_work,
    prepare_user_context_work,
    summarize_chain,
    summarize_user_context,
    user_context_ledger
};
import nomo.adapters.filesystem.editing.apply;
import nomo.adapters.storage.chains.{
    ParentAccess,
    WorkChainStoreTicket,
    abandon,
    admit_continue,
    admit_new,
    admit_user_context,
    begin,
    captured as chains_captured,
    claim,
    discover,
    publish_partial as chains_publish_partial,
    read_parent_access,
    work_chain_journal_complete,
    work_chain_journal_inspect,
    work_chain_store_complete,
    work_chain_store_inspect
};
import nomo.application.editing.ports.Approval as ports_Approval;
import nomo.application.sessions.chain.{request_error, selected_error, work};
import nomo.domain.editing.{Confirmed, Selector, bind, selector_error};
import nomo.domain.harness.loop.allowed_error;
import nomo.domain.harness.work.fresh;
import nomo.domain.sessions.chain.{
    CapturedJournal,
    CapturedShow,
    ContinueRequest,
    ParentFacts,
    Selector as chain_Selector,
    TurnRequest,
    WorkOutcome,
    WorkRequest,
    WorkStop,
    eligible,
    journal_phase,
    linked,
    parent_facts,
    publish_partial,
    select,
    values,
    work_chain_validate
};
import nomo.domain.sessions.work.{Pending, admit, partial, validate};
import nomo.domain.text.text_printable;
import nomo.domain.wire.{json, object};
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.work_chain.Record;
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.workspace.ReadOnlyRoot;
import std.bytes.len;
import std.codec.text.utf8_encode;
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println, read_line};
import std.runtime.error.IndexError;
import std.text.{char_count, from_i32, from_usize, replace, starts_with, trim};

public flow recovery_decision_run(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
    if args.len() != 2 { println("REFUSED expected TARGET ID"); return 1; }
    match abandon(args[0], args[1]) {
        Ok(_) => { println("DECISION abandon recorded; prior outcome remains unknown and no retry is authorized."); return 0; }
        Err(error) => { println("REFUSED " + error); return 1; }
    }
}

public type Selection = { root: string, mode: string, accepted: bool, input: WorkChainArgsInput };

flow root_error(root: string) -> string {
    if char_count(root) == 0 || char_count(root) > 512 || !starts_with(root, "/") { return "read root must be an absolute path of at most 512 characters"; }
    @limits([Iterations(514)]) for codepoint in std.text.chars(root) { let character = std.text.from_char(codepoint);
        if character != "" {
            let bytes = utf8_encode(character);
            if len(bytes) == 1 && (bytes[0] < 32 || bytes[0] == 127) { return "read root must not contain control characters"; }
        }
    }
    return "";
}

public flow selection(args: Array<string>) -> Result<Selection, string> {
    if args.len() < 14 || args.len() > 19 || args[0] != "--read-root" || args[2] != "--input-mode" {
        return Err("expected --read-root ROOT --input-mode MODE and bounded new-work options");
    }
    let root = args[1]; let mode = args[3];
    let invalid = root_error(root); if invalid != "" { return Err(invalid); }
    if mode != "tty" && mode != "non-tty" { return Err("invalid input mode"); }
    var rest: Array<string> = []; var accepted = false; var index: usize = 4;
    @limits([Iterations(16)]) while index < args.len() {
        let flag = args[index]; index = index + 1;
        if flag == "--accept-read-root" {
            if accepted { return Err("duplicate --accept-read-root"); }
            accepted = true;
        } else {
            if index >= args.len() { return Err("work option value missing"); }
            rest = rest.push(flag).push(args[index]); index = index + 1;
        }
    }
    if mode == "non-tty" && !accepted { return Err("non-TTY user-context work requires --accept-read-root"); }
    if mode == "tty" && accepted { return Err("TTY user-context work requires fresh interactive confirmation"); }
    let input = match work_chain_args_parse(rest, false) { Ok(value) => value, Err(error) => { return Err(error); } };
    if input.work.edit.help || input.work.edit.path != "demo/value.txt" { return Err("user-context work edits only the prepared demo/value.txt fixture"); }
    return Ok(Selection { root, mode, accepted, input });
}

public flow user_context_entry_run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] {
    let selected = match selection(args) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    var second = ""; if selected.input.work.allowed.len() == 2 { second = selected.input.work.allowed[1]; }
    let shown = match object(["root", "file1", "file2"], [selected.root, selected.input.work.allowed[0], second]) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; }
    };
    println("READ CONTEXT " + shown);
    println("The selected directory is already mounted read-only and is visible to the native process. The file allowlist is enforced by Nomo, not by a per-file OS mount.");
    println("An allowed path may follow a symbolic link inside the root; a hard link may expose content also linked elsewhere. Files can change during reading; this is not an atomic snapshot.");
    println("Allowed file contents may be sent to the configured model. This mode edits only the prepared demo file and cannot continue or resume another turn.");
    if selected.mode == "tty" {
        println("Allow this read context? Type yes to continue:");
        let answer = read_line();
        if answer == "" || trim(answer) != "yes" { println("REFUSED read-context consent was not given"); return 1; }
    }
    return execute_user_context(selected.input);
}

public flow render(row: Record, journal: Option<CapturedJournal>) -> Result<Array<string>, string> {
    let error = work_chain_validate(row); if error != "" { return Err(error); }
    let metadata = match object(["format", "phase", "chain", "id", "turn", "workspace", "region", "path", "parent_id", "parent_version", "parent_digest", "request"],
        [from_i32(row.format), row.phase, row.chain, row.id, from_i32(row.turn), row.workspace, row.region, row.path, row.parent_id, row.parent_version, row.parent_digest, row.request]) {
        Ok(value) => value, Err(error) => { return Err(error); } };
    var lines = ["CHAIN " + metadata]; let labels = ["ALLOWANCE ", "AVAILABLE ", "REMAINING ", "RESERVATION "];
    let caps = [row.maximum, row.available, row.remaining, row.reserved]; var index: usize = 0;
    let keys = ["steps", "calls", "generation", "native_tokens", "read_tools", "scan", "edit_reads", "edit_read_bytes", "atomic", "atomic_bytes"];
    @limits([Iterations(4)]) while index < 4 {
        let text = values(caps[index]).iter().map(number => from_i32(number)).collect();
        let encoded = match object(keys, text) { Ok(value) => value, Err(error) => { return Err(error); } };
        lines = lines.push(labels[index] + encoded); index = index + 1;
    }
    match journal {
        Some(value) => {
            let b = value.binding;
            let encoded = match object(["format", "phase", "chain", "turn", "id", "workspace", "region", "path", "request_digest", "before_digest", "after_digest", "before_bytes", "after_bytes"],
                ["2", value.phase, value.chain, from_i32(value.turn), b.id, b.workspace, b.region, b.path, b.request_digest, b.before_digest, b.after_digest, from_usize(b.before_bytes), from_usize(b.after_bytes)]) {
                Ok(item) => item, Err(error) => { return Err(error); } };
            lines = lines.push("JOURNAL " + encoded);
        }
        None() => { lines = lines.push("JOURNAL missing; missing journal is not proof that no edit occurred."); }
    }
    match row.work { Some(value) => { let shown = match editing_render(value) { Ok(item) => item, Err(error) => { return Err(error); } }; lines = lines.extend(shown); } None() => (), }
    let size = lines.iter().map(line => char_count(line) + 1).sum();
    if size > 262144 { return Err("chain display exceeds 262144 ASCII bytes"); }
    return Ok(lines);
}

public enum DetailedWorkOutcome { Completed, Stopped(WorkStop), UserContextStopped(WorkStop) }

flow stopped(state: Ledger, error: string) -> DetailedWorkOutcome { return DetailedWorkOutcome.Stopped(WorkStop { state, error }); }

public flow project_outcome(outcome: DetailedWorkOutcome) -> WorkOutcome {
    return match outcome {
        DetailedWorkOutcome.Completed => WorkOutcome.Completed,
        DetailedWorkOutcome.Stopped(value) => WorkOutcome.Stopped(value),
        DetailedWorkOutcome.UserContextStopped(value) => WorkOutcome.Stopped(value),
    };
}

public flow present_outcome(outcome: WorkOutcome) -> i32 {
    return match outcome { WorkOutcome.Completed => 0, WorkOutcome.Stopped(value) => {
        println("REFUSED " + value.error); chain_ledger(value.state); help_hint(); 1
    } };
}

public flow present_detailed_outcome(outcome: DetailedWorkOutcome) -> i32 {
    return match outcome {
        DetailedWorkOutcome.Completed => 0,
        DetailedWorkOutcome.Stopped(value) => present_outcome(WorkOutcome.Stopped(value)),
        DetailedWorkOutcome.UserContextStopped(value) => { println("REFUSED " + value.error); user_context_ledger(value.state); help_hint(); 1 }
    };
}

flow present_user_outcome(outcome: DetailedWorkOutcome) -> i32 {
    return match outcome {
        DetailedWorkOutcome.Completed => 0,
        DetailedWorkOutcome.Stopped(value) => { println("REFUSED " + value.error); user_context_ledger(value.state); help_hint(); 1 },
        DetailedWorkOutcome.UserContextStopped(value) => { println("REFUSED " + value.error); user_context_ledger(value.state); help_hint(); 1 }
    };
}

flow to_legacy_work(value: WorkRequest) -> Work {
    let edit = Input { help = false, id = value.selected.id, workspace = value.selected.workspace, path = value.selected.path, request = value.request };
    return Work { edit, allowed = value.allowed };
}

flow application_request(input: WorkChainArgsInput, continuing: bool) -> TurnRequest {
    let selected = Selector { id = input.work.edit.id, workspace = input.work.edit.workspace, path = input.work.edit.path };
    let value = WorkRequest { selected, request = input.work.edit.request, allowed = input.work.allowed, cap = input.cap };
    return if continuing { TurnRequest.Continue(ContinueRequest { parent = input.parent, work = value }) } else { TurnRequest.New(value) };
}

flow execute(ticket: WorkChainStoreTicket, pending: Pending) -> Result<Confirmed, string> {
    let selected = match confirm_current(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return Err(error); } };
    match claim(ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
    let intent = match begin(ticket.row.chain, ticket.row.turn, selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    println("INTENT durable " + selected.id);
    match apply(pending.prepared) { Ok(_) => (), Err(error) => { return Err(error); } }
    match work_chain_journal_complete(intent) { Ok(_) => (), Err(error) => { return Err(error); } }
    println("APPLIED " + selected.id);
    return Ok(Confirmed { binding = selected, after = pending.prepared.proposal.after });
}

flow execute_work(request: TurnRequest, inspect_plan: bool, inspect_all: bool, user_context: bool) -> DetailedWorkOutcome {
    let invalid = request_error(request); if invalid != "" { return stopped(fresh(), invalid); }
    let continuing = match request { TurnRequest.New(_) => false, TurnRequest.Continue(_) => true };
    if user_context && continuing { return stopped(fresh(), "user-context work cannot continue or resume"); }
    let parent_id = match request { TurnRequest.New(_) => "", TurnRequest.Continue(next) => next.parent };
    let value = work(request); let edit = value.selected; var prior: Array<ParentFacts> = []; var expected: Option<string> = None();
    if (inspect_plan || inspect_all) && ((inspect_plan && continuing) || edit.workspace != "local-tryout" || edit.path != "demo/value.txt" || value.allowed != ["demo/context.txt"]) {
        return stopped(fresh(), "read-plan inspection requires the fixed local-tryout fixture binding");
    }
    var selected_ticket: Option<WorkChainStoreTicket> = None();
    if continuing {
        let parent = match read_parent_access(parent_id, edit.workspace, edit.path) {
            ParentAccess.Found(value) => value,
            ParentAccess.Refused(error) => { return stopped(fresh(), error); }
            ParentAccess.UserContext => { return DetailedWorkOutcome.UserContextStopped(WorkStop { state = fresh(), error = "user-context work cannot continue or resume" }); }
        };
        prior = match parent_facts(parent.value) { Ok(value) => value, Err(error) => { return stopped(fresh(), error); } };
        let parent_work = match parent.value.work { Some(value) => value, None() => { return stopped(fresh(), "confirmed parent work missing"); } };
        let previous = match validate(parent_work) { Ok(value) => value, Err(error) => { return stopped(fresh(), error); } };
        expected = Some(previous.after);
        let saved = match admit_continue(parent_id, edit.id, edit.workspace, edit.path, value.request, value.allowed, value.cap, parent) {
            Ok(value) => value, Err(error) => { return stopped(fresh(), error); } };
        selected_ticket = Some(saved);
    } else {
        let admission = if user_context { admit_user_context(edit.id, edit.workspace, edit.path, value.request, value.allowed, value.cap) } else { admit_new(edit.id, edit.workspace, edit.path, value.request, value.allowed, value.cap) };
        let saved = match admission {
            Ok(value) => value, Err(error) => { return stopped(fresh(), error); } };
        selected_ticket = Some(saved);
    }
    let ticket = match selected_ticket { Some(value) => value, None() => { return stopped(fresh(), "v2 admission unavailable"); } };
    if user_context { println("ADMITTED user-context single turn; continuation and resume are unavailable; configured allowances, no automatic retry or refund."); }
    else { println("ADMITTED v2 complete turn reservation durable; lifetime26 steps/14 calls/94208 generation/393216 native/2 atomic attempts; configured allowances, no automatic retry or refund."); }
    show_hint(edit.id, edit.workspace, edit.path);
    let preparation = if user_context { prepare_user_context_work(to_legacy_work(value), prior, expected, inspect_plan, inspect_all) } else { prepare_chain_work(to_legacy_work(value), prior, expected, inspect_plan, inspect_all) };
    let pending = match preparation { Ok(value) => value, Err(failure) => { return stopped(failure.state, failure.error); } };
    let selected = pending.selected;
    let binding = match bind(selected.id, selected.workspace, selected.path, pending.prepared) { Ok(value) => value, Err(error) => { return stopped(pending.state, error); } };
    let candidate = match partial(binding, pending.evidence, pending.task, pending.prepared) { Ok(value) => value, Err(error) => { return stopped(pending.state, error); } };
    match admit(candidate) { Ok(_) => (), Err(error) => { return stopped(pending.state, error); } }
    let projection = match publish_partial(ticket.row, candidate) { Ok(value) => value, Err(error) => { return stopped(pending.state, error); } };
    match ticket.parent { Some(parent) => { let error = linked(parent.value, parent.version.opaque, projection); if error != "" { return stopped(pending.state, error); } } None() => (), }
    let outcome = match execute(ticket, pending) { Ok(value) => value, Err(error) => { return stopped(pending.state, error); } };
    println("EDIT completed " + edit.id + "; v2 journal is authoritative; no replay or rollback.");
    match json(["chain_show", "--id", edit.id, "--workspace", edit.workspace, "--path", edit.path]) { Ok(value) => println("NEXT " + value), Err(_) => (), }
    show_hint(edit.id, edit.workspace, edit.path);
    let completed = match completed_context_work(pending, outcome) { Ok(value) => value, Err(failure) => { return stopped(failure.state, failure.error); } };
    if outcome.binding != candidate.binding || outcome.after != pending.prepared.proposal.after { return stopped(completed.state, "edit completed; v2 snapshot binding mismatch"); }
    if user_context { println("WORK pending; edit completed; user-context snapshot not confirmed saved."); }
    else { println("WORK pending; edit completed; v2 snapshot not confirmed saved."); }
    let saved = match chains_publish_partial(ticket, candidate) { Ok(value) => value, Err(error) => { return stopped(completed.state, "edit completed; " + error); } };
    println("WORK durable summary-unconfirmed; final reservation may have been attempted; cannot resume an uncertain turn.");
    let aggregation = if user_context { summarize_user_context(completed, prior, inspect_all) } else { summarize_chain(completed, prior, inspect_all) };
    let summary = match aggregation { Ok(value) => value, Err(failure) => { return stopped(failure.state, failure.error); } };
    match work_chain_store_complete(saved, summary.answer) { Ok(_) => (), Err(error) => { return stopped(summary.state, "edit completed; " + error); } }
    if user_context { println("SAVED user-context summary-confirmed; reservation retained; no continuation."); }
    else { println("SAVED v2 summary-confirmed; cumulative lifetime reservation retained."); }
    display("FINAL ", summary.answer); if user_context { user_context_ledger(summary.state); } else { chain_ledger(summary.state); }
    if ticket.row.turn == 1 && !user_context { continue_hint(edit.id, edit.workspace, edit.path, value.allowed); }
    return DetailedWorkOutcome.Completed;
}

public flow execute_application_detailed(request: TurnRequest) -> DetailedWorkOutcome ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] { return execute_work(request, false, false, false); }

flow work_chain_entry_run(args: Array<string>, continuing: bool, inspect_plan: bool, inspect_all: bool) -> i32 {
    let input = match work_chain_args_parse(args, continuing) { Ok(value) => value, Err(error) => { return present_detailed_outcome(stopped(fresh(), error)); } };
    if input.work.edit.help { return help([]); }
    return present_detailed_outcome(execute_work(application_request(input, continuing), inspect_plan, inspect_all, false));
}

public flow run_new(args: Array<string>) -> i32 ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] { return work_chain_entry_run(args, false, false, false); }

public flow run_continue(args: Array<string>) -> i32 ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] { return work_chain_entry_run(args, true, false, false); }

public flow run_inspect(args: Array<string>) -> i32 ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] { return work_chain_entry_run(args, false, true, false); }

public flow run_observed_new(args: Array<string>) -> i32 ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] { return work_chain_entry_run(args, false, false, true); }

public flow run_observed_continue(args: Array<string>) -> i32 ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] { return work_chain_entry_run(args, true, false, true); }

public flow execute_user_context(input: WorkChainArgsInput) -> i32 ![Console, Memory, ports_Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<fs_IOError>, Error<BudgetExceeded>] {
    return present_user_outcome(execute_work(application_request(input, false), false, false, true));
}

public flow inspect_application(selected: Selector) -> Result<Option<CapturedShow>, string> {
    let invalid = selected_error(selected); if invalid != "" { return Err(invalid); }
    let row = match work_chain_store_inspect(selected.id, selected.workspace, selected.path) { Ok(Some(value)) => value, Ok(None()) => { return Ok(None()); } Err(error) => { return Err(error); } };
    let operation = match work_chain_journal_inspect(row.chain, row.turn, row.id, row.workspace, row.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    let captured = match operation { Some(value) => Some(chains_captured(value)), None() => None() };
    return Ok(Some(CapturedShow { row, journal = captured }));
}

public flow present_show(outcome: Result<Option<CapturedShow>, string>) -> i32 {
    return match outcome {
        Ok(Some(value)) => show_captured(value.row, value.journal),
        Ok(None()) => { println("CHAIN missing; missing data never establishes no edit occurred."); 0 }
        Err(error) => { println("REFUSED " + error); help_hint(); 1 }
    };
}

public flow work_chain_entry_run_show(args: Array<string>) -> i32 {
    let input = match edit_args_parse(args, false) { Ok(value) => value, Err(error) => { return present_show(Err(error)); } };
    if input.help { return help([]); }
    let selected = Selector { id = input.id, workspace = input.workspace, path = input.path };
    return present_show(inspect_application(selected));
}

public flow show_captured(row: Record, operation: Option<CapturedJournal>) -> i32 {
    let lines = match render(row, operation) { Ok(value) => value, Err(error) => { println("REFUSED " + error); help_hint(); return 1; } };
    @limits([Iterations(16)]) for line in lines { println(line); }
    if row.format == 3 { println("User-context work is single-turn; continuation and resume are unavailable."); }
    show_hint(row.id, row.workspace, row.path);
    if row.format == 3 { println("Remaining allocation is recorded history and does not authorize another turn."); }
    else { println("Remaining allocation belongs to the saved snapshot and does not establish current second-slot availability."); }
    println("Captured facts, not current File state. Admitted work may have an intent or completed edit without a work snapshot. No replay or refund; reservations are configured, not measured usage."); return 0;
}

// Literal shell arguments are data; no command is evaluated by these helpers.
public flow argument(value: string) -> Result<string, string> {
    if char_count(value) > 128 || !text_printable(value) { return Err("hint argument requires at most128 printable ASCII characters"); }
    return Ok("'" + replace(value, "'", "'\"'\"'") + "'");
}

flow bindings(id: string, workspace: string, path: string) -> Result<string, string> {
    let invalid = selector_error(id, workspace, path); if invalid != "" { return Err(invalid); }
    let identity = match argument(id) { Ok(value) => value, Err(error) => { return Err(error); } };
    let owner = match argument(workspace) { Ok(value) => value, Err(error) => { return Err(error); } };
    let file = match argument(path) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok("--id " + identity + " --workspace " + owner + " --path " + file);
}

public flow help_hint() -> unit {
    println("NEXT help (run from the project root):");
    println("./scripts/local-tryout.sh help");
}

public flow show_hint(id: string, workspace: string, path: string) -> unit {
    let selected = match bindings(id, workspace, path) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    println("NEXT inspect captured state (run from the project root with NOMO_TRYOUT_DIR set):");
    println("./scripts/local-tryout.sh show \"$NOMO_TRYOUT_DIR\" " + selected);
}

public flow continue_hint(parent: string, workspace: string, path: string, allowed: Array<string>) -> unit {
    let invalid = selector_error(parent, workspace, path);
    let files_error = allowed_error(allowed);
    if invalid != "" || files_error != "" { help_hint(); return; }
    let selected = match bindings("NEW_CHILD_ID", workspace, path) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    let identity = match argument(parent) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    var names = allowed[0]; if allowed.len() == 2 { names = names + "," + allowed[1]; }
    let files = match argument(names) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    println("TEMPLATE only: replace NEW_CHILD_ID with a distinct new ID and NEW_REQUEST with your new request.");
    println("The saved parent's remaining allocation is a snapshot; it does not establish current second-slot availability. Native admission and fresh confirmation still apply.");
    println("./scripts/local-tryout.sh continue \"$NOMO_TRYOUT_DIR\" --parent " + identity + " " + selected + " --once 'NEW_REQUEST' --allow " + files);
}

public flow help(args: Array<string>) -> i32 {
    if args.len() > 1 || (args.len() == 1 && args[0] != "help" && args[0] != "--help") {
        println("REFUSED chain_help accepts no arguments or one --help."); help_hint(); return 1;
    }
    println("Nomo fixed local tryout: one newly prepared private fixture/store, one v2 lifetime, at most two currently confirmed edits.");
    println("Native ETAS entries (select work-chain for new/continue, work-chain-show for show, chain-help for help):");
    println("chain_new --id ID --workspace BIND --path FILE --once REQUEST --allow FILE[,FILE] [--cap CSV]");
    println("chain_continue --parent ROOT_ID --id NEW_CHILD_ID --workspace BIND --path FILE --once REQUEST --allow FILE[,FILE] [--cap CSV]");
    println("chain_show --id ID|--latest --workspace BIND --path FILE");
    println("chain_sessions --workspace BIND --path FILE (host: local-tryout.sh sessions DIRECTORY OPTIONS)");
    println("Latest selects the highest validated turn in this configured one-chain store. Any second slot blocks another continuation; no root fallback.");
    println("chain_help [--help]");
    println("Host launcher from the project root; export NOMO_TRYOUT_DIR to one new, unused directory before prepare:");
    println("./scripts/local-tryout.sh prepare \"$NOMO_TRYOUT_DIR\"");
    println("./scripts/local-tryout.sh new \"$NOMO_TRYOUT_DIR\" --id 'tryout-1' --workspace 'local-tryout' --path 'demo/value.txt' --once 'Replace old with the color from demo/context.txt' --allow 'demo/context.txt'");
    show_hint("tryout-1", "local-tryout", "demo/value.txt");
    println("After the new process shows a confirmed first turn, choose a distinct child ID and request; every edit needs native yes followed by Nomo y/yes on a TTY.");
    continue_hint("tryout-1", "local-tryout", "demo/value.txt", ["demo/context.txt"]);
    println("--cap has ten canonical decimal counters: steps,calls,generation,native_tokens,read_tools,scan,edit_reads,edit_read_bytes,atomic,atomic_bytes.");
    println("Default/current hard maximum:13,7,47104,196608,1,4096,3,6144,1,2048; any smaller dimension refuses a whole turn before admission/work.");
    println("Declared two-turn lifetime:26,14,94208,393216,2,8192,6,12288,2,4096. These are configured allowances, not measured Provider usage.");
    println("Requests are1..65536 printable ASCII characters; read paths1..2 at most48 characters each; edit path at most128 characters/eight components; edit text at most1048576 UTF-8 bytes.");
    println("Show uses captured application/journal facts only and never checks the current File. An admitted row may already have an intent/completed journal without a work snapshot.");
    println("Optional user-context-new reads explicitly allowed files from --read-root ABSOLUTE_DIRECTORY and edits only the prepared demo/value.txt. It is single-turn and cannot resume or continue.");
    println("Example: local-tryout.sh user-context-new DIRECTORY --read-root ABSOLUTE_DIRECTORY --id ID --workspace BIND --path demo/value.txt --once REQUEST --allow FILE[,FILE].");
    println("The whole selected directory is mounted read-only and visible to the native process. Internal symlinks and hard links may expose content; reads are not atomic snapshots. Allowed content may be sent to the configured model.");
    println("TTY mode requires fresh read-context confirmation. Non-TTY mode requires --accept-read-root and denies edit approval.");
    println("V1, partial, denied, consumed or unknown work cannot be resumed/replayed here. Approval is current each turn; failed work is not reset, repaired or refunded.");
    println("Help/list/show need no Provider configuration. See docs/agent/LOCAL_TRYOUT_GUIDE.md for the current setup and private Model configuration.");
    return 0;
}

flow refused(error: string) -> i32 { println("REFUSED " + error); help_hint(); return 1; }

public flow run_sessions(args: Array<string>) -> i32 {
    let input = match work_chain_selection_args_parse(args, chain_input_Command.Sessions) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.help { return help([]); }
    let view = match discover(input.workspace, input.path, chain_Selector.All) { Ok(value) => value, Err(error) => { return refused(error); } };
    let rows = match select(view, input.workspace, input.path, chain_Selector.All) { Ok(value) => value, Err(error) => { return refused(error); } };
    if rows.len() == 0 { println("SESSIONS empty; missing records never establish that no edit occurred."); }
    @limits([Iterations(2)]) for row in rows {
        let encoded = match object(["id", "turn", "phase", "journal", "continuation_eligible", "workspace", "path"],
            [row.id, from_i32(row.turn), row.phase, journal_phase(view, row.turn),
                if row.turn == 1 && eligible(view, input.workspace, input.path) { "true" } else { "false" }, row.workspace, row.path]) {
            Ok(value) => value, Err(error) => { return refused(error); } };
        println("SESSION " + encoded);
        if row.format == 3 { println("User-context work is single-turn; continuation and resume are unavailable."); }
    }
    println("Captured fixed slots only. Continuation revalidates the graph, journals and admission; no replay, refund or current File claim.");
    return 0;
}

public flow work_chain_sessions_run_show(args: Array<string>) -> i32 {
    let input = match work_chain_selection_args_parse(args, chain_input_Command.Show) { Ok(value) => value, Err(error) => { return refused(error); } };
    if input.help { return help([]); }
    let view = match discover(input.workspace, input.path, input.selector) { Ok(value) => value, Err(error) => { return refused(error); } };
    let selected = match select(view, input.workspace, input.path, input.selector) { Ok(value) => value, Err(error) => { return refused(error); } };
    if selected.len() == 0 { println("CHAIN missing; missing data never establishes no edit occurred."); return 0; }
    let row = selected[0];
    let observed = if row.turn == 1 { view.root_journal } else { view.child_journal };
    let journal = match observed { Some(value) => Some(value.value), None() => None() };
    return show_captured(row, journal);
}
