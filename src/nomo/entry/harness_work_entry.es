module nomo.entry.harness_work_entry;

public import nomo.application.work_contract.{Failure, Pending, Completed, Summary};

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.harness.work.controller.{HarnessWorkStage, historical_ledger_text, expanded_ledger_text, prepare_with as application_prepare_with, prepare_unicode as application_prepare_unicode, prepare_expanded_unicode as application_prepare_expanded_unicode, complete as application_complete, finish_summary as application_finish_summary, finish_history_summary as application_finish_history_summary};
import nomo.cli.harness_work_args.{Work, parse, application as application_request};
import nomo.harness.harness_work_contract.{Ledger, fresh};
import nomo.harness.harness_model_tools.{work_child_turn, chain_child_turn};
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.edit_original.EditOriginal;
import nomo.harness.harness_work_model.{read_main, edit_plan, edit_child, aggregate};
import nomo.harness.work_chain_context.ParentFacts;
import nomo.harness.work_chain_model.{plan as chain_plan, child as chain_child, aggregate as chain_aggregate};
import nomo.model.diagnostic_output.DiagnosticOutput;
import nomo.model.harness_progress.HarnessProgress;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, read_original, read_original_wide};
import nomo.session.edit_operation_store.available;
import nomo.entry.edit_coordinator.{Approval, Confirmed, execute};
import nomo.entry.edit_context.{recorded, display};

public flow ledger(state: Ledger) -> unit {
    println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
}
public flow chain_ledger(state: Ledger) -> unit {
    println(historical_ledger_text(state) + "; per-turn configured allowances are not measured usage; bounded v2 continuation requires a fresh durable claim and current confirmation");
}
public flow user_context_ledger(state: Ledger) -> unit {
    println(historical_ledger_text(state) + "; per-turn configured allowances are not measured usage; user-context work cannot continue or resume");
}
flow chain_stage(name: string, state: Ledger, user_context: bool) -> unit {
    println("STAGE " + name);
    if user_context { user_context_ledger(state); } else { chain_ledger(state); }
}

public flow refused(state: Ledger, error: string) -> i32 { println("REFUSED " + error); ledger(state); return 1; }
flow stage(name: string, state: Ledger) -> unit { println("STAGE " + name); ledger(state); }
flow help() -> unit {
    println("One read-context/edit workflow: --id ID --workspace BIND --path EDITFILE --once TASK --allow FILE[,FILE].");
    println("Overall request/read task1..128 printable ASCII;1..2 read paths<=48 characters, raw allow<=97; complete read context<=2048 serialized characters.");
    println("One read/search,16384 scan allowance; complete display result<=65536 UTF-8 bytes, search yields locations. Edit original/result<=16384 UTF-8 bytes, whole edit/read data<=262144 bytes.");
    println("Maximum13 steps /7 Model calls /47104 generation /196608 historical native allowance (not a provider token cap) /3 edit reads with6144-byte allowance /1 atomic attempt. Edit tail reserved before read.");
    println("Exclusive owned disposable workspace/store; native yes then Nomo y/yes. Data-only edit_status, no automatic retries or mutating resume.");
}

public flow prepare_with<effect E>(input: Work, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![E], chain_read: bool, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> ![Console, EditOriginal, LegacyStringStages, LegacyEditStages, Error<ConsoleError>, Error<IndexError>, E] {
    return application_prepare_with(application_request(input), original_error, chain_read, inspect_plan, inspect_all) with {
        HarnessWorkStage.write(name, state) => { stage_log(name, state); resume; }
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
}

public flow prepare_unicode<effect E>(input: Work, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![E]) -> Result<Pending, Failure> ![Console, LegacyStringStages, LegacyEditStages, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<ConsoleError>, Error<IndexError>, E] {
    return application_prepare_unicode(application_request(input), original_error) with {
        HarnessWorkStage.write(name, state) => { stage_log(name, state); resume; }
        EditOriginal.read(path) => { resume read_original(path); }
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
}

public flow prepare_expanded_unicode<effect E>(input: Work, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![E], wide: bool) -> Result<Pending, Failure> ![Console, LegacyStringStages, LegacyEditStages, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<ConsoleError>, Error<IndexError>, E] {
    return application_prepare_expanded_unicode(application_request(input), original_error, wide, false) with {
        HarnessWorkStage.write(name, state) => { stage_log(name, state); resume; }
        EditOriginal.read(path) => { resume read_original_wide(path); }
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
}

public flow expanded_stage(name: string, state: Ledger, wide: bool) -> unit { println("STAGE " + name); expanded_ledger(state, wide); }
public flow simple_refused(error: string) -> i32 { println("REFUSED " + error); return 1; }
public flow expanded_ledger(state: Ledger, wide: bool) -> unit { println(expanded_ledger_text(state, wide, false)); }
public flow expanded_ledger_mode(state: Ledger, wide: bool, high_input: bool) -> unit { println(expanded_ledger_text(state, wide, high_input)); }

public flow prepare<effect E>(input: Work, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![E], chain_read: bool, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> ![Console, LegacyStringStages, LegacyEditStages, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<ConsoleError>, Error<IndexError>, E] {
    return prepare_with<![E]>(input, original_error, stage_log, chain_read, inspect_plan, inspect_all) with {
        EditOriginal.read(path) => { resume read_original(path); }
    };
}

public flow prepare_work(input: Work) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => "";
    let log: (string, Ledger) -> unit ![Error<ConsoleError>] = (name: string, state: Ledger) => stage(name, state);
    return prepare<![Error<ConsoleError>]>(input, original, log, false, false, false) with {
        LegacyStringStages.main(value) => { resume read_main(value); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume edit_plan(value); }
        LegacyEditStages.child(value) => { resume edit_child(value); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value); }
    };
}

flow prepare_chain_mode(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool, user_context: bool) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => match expected { Some(before) => if value == before { "" } else { "current original differs from confirmed parent result" }, None() => "" };
    let log: (string, Ledger) -> unit ![Error<ConsoleError>] = (name: string, state: Ledger) => chain_stage(name, state, user_context);
    return prepare<![Error<ConsoleError>]>(input, original, log, true, inspect_plan, inspect_all) with {
        LegacyStringStages.main(value) => { resume read_main(value); }
        LegacyStringStages.child(task, files, selected) => { resume chain_child_turn(task, files, selected, inspect_all); }
        LegacyEditStages.plan(value) => { resume chain_plan(value, parent); }
        LegacyEditStages.child(value) => { resume chain_child(value, parent); }
        LegacyEditStages.aggregate(value) => { resume chain_aggregate(value, parent); }
    };
}

public flow prepare_chain_work(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_chain_mode(input, parent, expected, inspect_plan, inspect_all, false);
}
public flow prepare_user_context_work(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_chain_mode(input, parent, expected, inspect_plan, inspect_all, true);
}

public flow completed_context_work(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    return application_complete(pending, outcome);
}
public flow finish_edit(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    recorded(pending.selected); return application_complete(pending, outcome);
}

public flow finish_summary<effect E>(completed: Completed, stage_log: (string, Ledger) -> unit ![E], work: bool, inspect_all: bool) -> Result<Summary, Failure> ![Console, LegacyEditStages, Error<ConsoleError>, Error<IndexError>, E] {
    return application_finish_summary(completed, work, inspect_all) with {
        HarnessWorkStage.write(name, state) => { stage_log(name, state); resume; }
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
}
public flow finish_history_summary<effect E>(completed: Completed, stage_log: (string, Ledger) -> unit ![E]) -> Result<Summary, Failure> ![Console, LegacyEditStages, Error<ConsoleError>, Error<IndexError>, E] {
    return application_finish_history_summary(completed) with {
        HarnessWorkStage.write(name, state) => { stage_log(name, state); resume; }
        HarnessProgress.write(line) => { println(line); resume; }
        DiagnosticOutput.write(line) => { println(line); resume; }
    };
}

public flow summarize(completed: Completed) -> Result<Summary, Failure> {
    let log: (string, Ledger) -> unit ![Error<ConsoleError>] = (name: string, state: Ledger) => stage(name, state);
    return finish_summary<![Error<ConsoleError>]>(completed, log, false, false) with {
        LegacyEditStages.plan(value) => { resume edit_plan(value); }
        LegacyEditStages.child(value) => { resume edit_child(value); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value); }
    };
}
flow summarize_chain_mode(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool, user_context: bool) -> Result<Summary, Failure> {
    let log: (string, Ledger) -> unit ![Error<ConsoleError>] = (name: string, state: Ledger) => chain_stage(name, state, user_context);
    return finish_summary<![Error<ConsoleError>]>(completed, log, true, inspect_all) with {
        LegacyEditStages.plan(value) => { resume chain_plan(value, parent); }
        LegacyEditStages.child(value) => { resume chain_child(value, parent); }
        LegacyEditStages.aggregate(value) => { resume chain_aggregate(value, parent); }
    };
}
public flow summarize_chain(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<Summary, Failure> {
    return summarize_chain_mode(completed, parent, inspect_all, false);
}
public flow summarize_user_context(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<Summary, Failure> {
    return summarize_chain_mode(completed, parent, inspect_all, true);
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let input = match parse(args) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if input.edit.help { help(); return 0; }
    match available() { Ok(_) => {} Err(error) => { return refused(fresh(), error); } }
    let pending = match prepare_work(input) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let outcome = match execute(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    let completed = match finish_edit(pending, outcome) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let summary = match summarize(completed) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    display("FINAL ", summary.answer); ledger(summary.state); return 0;
}
