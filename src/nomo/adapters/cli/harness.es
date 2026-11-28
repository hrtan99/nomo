module nomo.adapters.cli.harness;

import nomo.domain.harness.delegation.DelegationStatus;
import nomo.domain.harness.edit.{EditStage};
import nomo.adapters.cli.console.{
    ascii_read_refused,
    display,
    expanded_ledger,
    ledger as console_ledger,
    recorded,
    text_delegation_refused,
    unicode_read_refused
};
import nomo.adapters.cli.edit_input.{Work, application, harness_edit_args_parse, harness_work_args_parse};
import nomo.adapters.cli.editing.execute;
import nomo.adapters.cli.input.{cli_request_parse_args, cli_request_parse_line, read_cli_parse_args};
import nomo.adapters.cli.model.run_mode;
import nomo.adapters.filesystem.editing.{read_original, read_original_wide};
import nomo.adapters.model.text.{aggregate, plan, propose};
import nomo.adapters.model.work.{
    child,
    edit_child,
    edit_plan,
    harness_work_model_aggregate,
    plan as work_plan,
    read_main,
    work_chain_model_aggregate
};
import nomo.adapters.storage.edits.edit_operation_store_available;
import nomo.application.editing.ports.{Approval as ports_Approval, EditOriginal};
import nomo.application.harness.ports.{DiagnosticOutput, HarnessProgress, LegacyEditStages, LegacyStringStages};
import nomo.application.harness.work.{
    HarnessWorkStage,
    complete,
    finish_history_summary as work_finish_history_summary,
    finish_summary as work_finish_summary,
    historical_ledger_text,
    prepare_expanded_unicode as work_prepare_expanded_unicode,
    prepare_unicode as work_prepare_unicode,
    prepare_with as work_prepare_with
};
import nomo.application.resources.{EditableRoot, ReadOnlyRoot};
import nomo.bootstrap.harness.{ascii_read_run, ascii_read_work_child_turn, chain_child_turn, harness_run, run_text, unicode_read_run};
import nomo.domain.editing.{Confirmed, Selector, prepare_original_legacy};
import nomo.domain.harness.delegation.{ProcessJob, Outcome};
import nomo.domain.harness.edit.{
    EditLedger,
    bump,
    completed_context,
    context as edit_context,
    context_error,
    decode_edit,
    decode_plan,
    fresh,
    text_error
};
import nomo.domain.harness.read.{read_fresh, text_fresh};
import nomo.domain.harness.work.{WorkLedger, fresh as work_fresh};
import nomo.domain.sessions.chain.ParentFacts;
import nomo.domain.sessions.work.{Completed, Failure, Pending, Summary};
import nomo.domain.text.within;
import std.effects.Fs;
import std.fs.IOError as fs_IOError;
import std.io.{IOError, println, read_line};
import std.text.{char_count, from_i32, split};

flow harness_chat_help() -> unit {
    println("Nomo harness chat (offline, serial, one child per turn): new");
    println("Limits: 3 admitted prompts, 16 raw lines, shared maximum 16 steps; tasks 1..256 characters.");
    println("Context: prior successful user tasks only; /help, /exit and EOF spend no steps.");
    println("Fresh in-memory only; no resume, one-shot, live model, real tools, concurrency or cancellation.");
}

flow emit(outcome: Outcome, turn: i32) -> unit {
    // child-1 is local to each coordinator call, so qualify every record by turn.
    let prefix = "TURN " + from_i32(turn) + " ";
    @limits([Iterations(3)]) for message in outcome.messages {
        println(
            prefix + "EVENT " + message.sender.wire() + " -> " + message.recipient.wire() + " "
                + message.kind.wire() + " "
                + message.child_id + ": " + message.text
        );
    }
    println(prefix + "FINAL " + outcome.status.wire() + ": " + outcome.text);
    println(
        prefix + "LEDGER maximum=" + from_i32(outcome.ledger.maximum) + " spent="
            + from_i32(outcome.ledger.spent) + " reserved=" + from_i32(outcome.ledger.reserved)
    );
}

flow stop(reason: string, turns: i32, spent: i32) -> unit {
    println("STOP " + reason + " turns=" + from_i32(turns) + " spent=" + from_i32(spent));
}

// HARNESS-002A: only line orchestration; parser, child policy and settlement stay
// in the accepted modules. No previous child answer is copied into context.
public flow harness_chat_run(args: Array<string>) -> i32 {
    let request = match cli_request_parse_args(args) {
        Ok(value) => value,
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    if request.is_help() {
        harness_chat_help();
        return 0;
    }
    if !request.is_new() {
        println("REFUSED resume is unavailable in the offline harness chat");
        return 1;
    }
    if request.once() != None() {
        println("REFUSED this line entry requires new without --once");
        return 1;
    }
    // This invocation alone owns the cumulative ledger and bounded selected data.
    var context: Array<string> = [];
    var spent: i32 = 0;
    var turns: i32 = 0;
    var lines: i32 = 0;
    println("Nomo harness chat (fresh, non-durable). /help for limits; /exit to quit.");
    @limits([Iterations(16)]) while lines < 16 {
        let raw = read_line();
        if raw == "" {
            stop("EOF", turns, spent);
            return 0;
        }
        lines = lines + 1;
        match cli_request_parse_line(raw) {
            Err(error) => println("REFUSED " + error),
            Ok(command) => {
                if command.is_exit() {
                    stop("exit", turns, spent);
                    return 0;
                }
                if command.is_help() {
                    harness_chat_help();
                }
                else {
                    let job = ProcessJob {
                        task = command.prompt(),
                        context,
                        maximum = 16,
                        spent
                    };
                    match harness_run(job) {
                        Err(error) => println("REFUSED " + error),
                        Ok(outcome) => {
                            turns = turns + 1;
                            spent = outcome.ledger.spent;
                            emit(outcome, turns);
                            if outcome.status != DelegationStatus.Completed {
                                stop("child refused", turns, spent);
                                return 1;
                            }
                            if turns == 3 {
                                stop("turn limit", turns, spent);
                                return 0;
                            }
                            context = context.push(command.prompt());
                        }
                    };
                }
            },
        };
    }
    println("REFUSED line limit reached; start a new in-memory invocation");
    return 1;
}

flow ledger(state: EditLedger) -> unit {
    println(
        "LEDGER steps=" + from_i32(state.steps) + "/6 calls=" + from_i32(state.calls) + "/3 token_allowance="
            + from_i32(state.tokens) + "/38912 boundaries=" + from_i32(state.boundaries)
            + "/3 native_token_allowance=" + from_i32(state.native_tokens)
            + "/163840; allowances are not provider usage; journal does not persist model history or budgets"
    );
}

flow harness_edit_entry_refused(state: EditLedger, error: string) -> i32 {
    println("REFUSED " + error);
    ledger(state);
    return 1;
}

flow harness_edit_entry_stage(phase: EditStage, state: EditLedger) -> unit {
    println(
        "STAGE " + phase.wire() + " child-1 steps=" + from_i32(state.steps) + " calls="
            + from_i32(state.calls)
            + " token_allowance=" + from_i32(state.tokens) + " remaining_calls=" + from_i32(3 - state.calls)
            + " remaining_token_allowance=" + from_i32(38912 - state.tokens) + " native_token_allowance="
            + from_i32(state.native_tokens) + " remaining_native_token_allowance="
            + from_i32(163840 - state.native_tokens)
    );
}

flow harness_edit_entry_help() -> unit {
    println("Nomo one-shot model edit: --id ID --workspace BIND --path FILE --once TASK (flags in any order).");
    println("One exclusive owned disposable workspace/store; one existing NUL-free UTF-8 file, 1..1048576 bytes before and at most1048576 after.");
    println("Task/delegation/summary1..1048576 UTF-8 bytes; child literal edit JSON<=16777216 bytes; complete model context<=33554432 bytes.");
    println("Maximum6 orchestration steps /3 Model attempts /38912 token allowance /3 file reads (6144-byte allowance) /1 atomic replacement.");
    println("Native cumulative token ceiling163840 includes input and output; generation limits4096/32768/2048, native allocations32768/65536/65536.");
    println("Current native yes then Nomo y/yes; same/different ID cannot reuse a consumed store. Journal stores edit facts, not model history or resume.");
}

public flow harness_edit_entry_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    ports_Approval,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    var state = fresh();
    let input = match harness_edit_args_parse(args) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    if input.help {
        harness_edit_entry_help();
        return 0;
    }
    let selected = Selector {
        id = input.id,
        workspace = input.workspace,
        path = input.path
    };
    // Before File or Model, every existing slot consumes the invocation.
    match edit_operation_store_available() {
        Ok(_) => (),
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    }
    let before = match read_original(input.path) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    let initial = edit_context(EditStage.Plan, selected, input.request, "", before);
    let invalid = context_error(initial);
    if invalid != "" {
        return harness_edit_entry_refused(state, invalid);
    }
    state = match bump(state, true) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    harness_edit_entry_stage(EditStage.Plan, state);
    let task = match decode_plan(plan(initial)) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    state = match bump(state, false) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    display("EVENT main -> child-1 request ", task);
    let delegated = edit_context(EditStage.Child, selected, input.request, task, before);
    let invalid_child = context_error(delegated);
    if invalid_child != "" {
        return harness_edit_entry_refused(state, invalid_child);
    }
    state = match bump(state, true) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    harness_edit_entry_stage(EditStage.Child, state);
    let request = match decode_edit(propose(delegated)) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    let prepared = match prepare_original_legacy(input.path, before, request.target, request.replacement) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    state = match bump(state, false) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    let outcome = match execute(selected, prepared) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, error);
        }
    };
    // Source receives a typed value only after the shared coordinator proves
    // durable completion. Announce it before a Model abort can terminate here.
    recorded(selected);
    state = match bump(state, false) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, "edit completed; " + error);
        }
    };
    println("EVENT child-1 -> main completed " + outcome.binding.id);
    let final_context = completed_context(input.request, task, before, outcome);
    let invalid_final = context_error(final_context);
    if invalid_final != "" {
        return harness_edit_entry_refused(
            state,
            "edit completed; aggregation context refused: " + invalid_final
        );
    }
    state = match bump(state, true) {
        Ok(value) => value,
        Err(error) => {
            return harness_edit_entry_refused(state, "edit completed; " + error);
        }
    };
    harness_edit_entry_stage(EditStage.Aggregate, state);
    let answer = aggregate(final_context);
    let invalid_answer = text_error(answer, "final answer");
    if invalid_answer != "" {
        return harness_edit_entry_refused(state, "edit completed; " + invalid_answer);
    }
    display("FINAL ", answer);
    ledger(state);
    return 0;
}

flow harness_entry_help() -> unit {
    println("Nomo harness (offline, serial, one child): new --once TEXT");
    println("Task: 1..256 raw printable ASCII characters; shared maximum 5 steps.");
    println("Stub/fake echo only: plain text, tool:echo:TEXT, stub:fail, tool:echo:fail.");
    println("One-shot only; no durable session creation, resume, interactive input, live model or concurrency.");
}

// HARNESS-001B: the adapter adds only Console output, not a second agent policy.
public flow harness_entry_run(args: Array<string>) -> i32 {
    let request = match cli_request_parse_args(args) {
        Ok(value) => value,
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    if request.is_help() {
        harness_entry_help();
        return 0;
    }
    if !request.is_new() {
        println("REFUSED resume is unavailable in the offline harness entry");
        return 1;
    }
    if request.once() == None() {
        println("REFUSED this entry requires new --once TEXT");
        return 1;
    }
    let context: Array<string> = [];
    // Pass exact raw data; admission enforces 256 before calling the child.
    let job = ProcessJob {
        task = request.once().unwrap(),
        context,
        maximum = 5,
        spent = 0
    };
    let outcome = match harness_run(job) {
        Ok(value) => value,
        Err(error) => {
            println("REFUSED " + error);
            return 1;
        }
    };
    @limits([Iterations(3)]) for message in outcome.messages {
        println(
            "EVENT " + message.sender.wire() + " -> " + message.recipient.wire() + " " + message.kind.wire()
                + " "
                + message.child_id + ": " + message.text
        );
    }
    println("FINAL " + outcome.status.wire() + ": " + outcome.text);
    println(
        "LEDGER maximum=" + from_i32(outcome.ledger.maximum) + " spent=" + from_i32(outcome.ledger.spent)
            + " reserved=" + from_i32(outcome.ledger.reserved)
    );
    if outcome.status != DelegationStatus.Completed {
        return 1;
    }
    return 0;
}

flow harness_model_entry_help() -> unit {
    println("Nomo model harness: new --once TEXT (fresh, one-shot, one depth-one child).");
    println("Main plan -> child response -> main aggregate; request/task 1..128, child 1..256, final 1..512 printable ASCII.");
    println("Plan: [\"delegate\",\"TASK\"], raw encoding <=384; each complete Prompt.data <=2048 characters.");
    println("Shared maximum 5 steps / 3 calls / 6144 token-allowance units; 2048 per attempted call, no refunds or retries.");
    println("Token allowance is not measured usage. Host aborts may leave only the last precharged STAGE marker.");
    println("No resume, line mode, real tools, persistence, concurrency or cancellation.");
}

public flow harness_model_entry_run(args: Array<string>) -> i32 {
    let request = match cli_request_parse_args(args) {
        Ok(value) => value,
        Err(error) => {
            return text_delegation_refused(text_fresh(), error);
        }
    };
    if request.is_help() {
        harness_model_entry_help();
        return 0;
    }
    if !request.is_new() {
        return text_delegation_refused(text_fresh(), "resume is unavailable in the model harness");
    }
    if request.once() == None() {
        return text_delegation_refused(text_fresh(), "this entry requires new --once TEXT");
    }
    return run_text(request.once().unwrap());
}

public flow harness_model_tools_chat_run(args: Array<string>) -> i32 {
    return run_mode(args, false);
}

flow harness_model_tools_entry_help() -> unit {
    println("Nomo model/tool harness: new --once TEXT --allow FILE[,FILE] (either flag order).");
    println("Raw request/task 1..128, child 1..256, final 1..512 printable ASCII; 1..2 paths of <=48 characters, raw allowlist <=97.");
    println("Shared maximum: 7 steps / 4 model calls / 8192 token allowance / 1 read-or-search / 4096 scan allowance; not measured usage.");
    println("Complete model context <=2048. Read size checked after reading. One fresh serial child; no writes, commands, resume, line mode or persistence. Host aborts may leave reservations unresolved.");
}

public type AllowArgs = {
    remaining: Array<string>,
    supplied: bool,
    allowed: string
};

public flow extract_allow(args: Array<string>, unicode: bool) -> Result<AllowArgs, string> {
    if args.len() == 0 || args.len() > 7 {
        return Err("expected bounded model/tool arguments");
    }
    var remaining: Array<string> = [args[0]];
    var supplied = false;
    var allowed = "";
    var index: usize = 1;
    @limits([Iterations(7)]) while index < args.len() {
        let flag = args[index];
        if flag == "--allow" {
            if supplied || index + 1 >= args.len() {
                return Err(if unicode {
                    "expected exactly one --allow FILE[,FILE...]"
                } else {
                    "expected exactly one --allow FILE[,FILE]"
                });
            }
            allowed = args[index + 1];
            if unicode && !within(allowed, 195) {
                return Err("raw allowlist exceeds 195 UTF-8 bytes");
            }
            if !unicode && char_count(allowed) > 97 {
                return Err("raw allowlist exceeds 97 characters");
            }
            supplied = true;
            index = index + 2;
        } else {
            remaining = remaining.push(flag);
            index = index + 1;
            if (flag == "--once" || flag == "--id") && index < args.len() {
                remaining = remaining.push(args[index]);
                index = index + 1;
            }
        }
    }
    return Ok(AllowArgs {
        remaining,
        supplied,
        allowed
    });
}

public flow harness_model_tools_entry_run(args: Array<string>) -> i32 {
    if args.len() == 0 || args.len() > 7 {
        return ascii_read_refused(read_fresh(), "expected bounded new --once TEXT --allow FILE[,FILE]");
    }
    let extracted = match extract_allow(args, false) {
        Ok(value) => value,
        Err(error) => {
            return ascii_read_refused(read_fresh(), error);
        }
    };
    let request = match cli_request_parse_args(extracted.remaining) {
        Ok(value) => value,
        Err(error) => {
            return ascii_read_refused(read_fresh(), error);
        }
    };
    if request.is_help() {
        if extracted.supplied {
            return ascii_read_refused(read_fresh(), "help must be used alone");
        }
        harness_model_tools_entry_help();
        return 0;
    }
    if !request.is_new() {
        return ascii_read_refused(read_fresh(), "resume is unavailable in the model/tool harness");
    }
    if request.once() == None() {
        return ascii_read_refused(read_fresh(), "this entry requires new --once TEXT");
    }
    if !extracted.supplied {
        return ascii_read_refused(read_fresh(), "this entry requires --allow FILE[,FILE]");
    }
    return ascii_read_run(request.once().unwrap(), split(extracted.allowed, ","));
}

public flow chain_ledger(state: WorkLedger) -> unit {
    println(
        historical_ledger_text(state)
            + "; per-turn configured allowances are not measured usage; bounded v2 continuation requires a fresh durable claim and current confirmation"
    );
}

public flow user_context_ledger(state: WorkLedger) -> unit {
    println(
        historical_ledger_text(state)
            + "; per-turn configured allowances are not measured usage; user-context work cannot continue or resume"
    );
}

flow chain_stage(name: string, state: WorkLedger, user_context: bool) -> unit {
    println("STAGE " + name);
    if user_context {
        user_context_ledger(state);
    } else {
        chain_ledger(state);
    }
}

public flow harness_work_entry_refused(state: WorkLedger, error: string) -> i32 {
    println("REFUSED " + error);
    console_ledger(state);
    return 1;
}

flow harness_work_entry_stage(name: string, state: WorkLedger) -> unit {
    println("STAGE " + name);
    console_ledger(state);
}

flow harness_work_entry_help() -> unit {
    println("One read-context/edit workflow: --id ID --workspace BIND --path EDITFILE --once TASK --allow FILE[,FILE].");
    println("Overall request/read task1..65536 printable ASCII;1..2 read paths<=48 characters, raw allow<=97; complete read context<=33554432 serialized characters.");
    println("One read/search,16384 scan allowance; complete display result<=65536 UTF-8 bytes, search yields locations. Edit original/result<=1048576 UTF-8 bytes, whole edit/read data<=262144 bytes.");
    println("Maximum13 steps /7 Model calls /47104 generation /196608 historical native allowance (not a provider token cap) /3 edit reads with6144-byte allowance /1 atomic attempt. Edit tail reserved before read.");
    println("Exclusive owned disposable workspace/store; native yes then Nomo y/yes. Data-only edit_status, no automatic retries or mutating resume.");
}

public flow prepare_with<effect E>(
    input: Work,
    original_error: (string) -> string ![],
    stage_log: (string, WorkLedger) -> unit ![E],
    chain_read: bool,
    inspect_plan: bool,
    inspect_all: bool
) -> Result<Pending, Failure> ![
    Console,
    EditOriginal,
    LegacyStringStages,
    LegacyEditStages,
    Error<IOError>,
    Error<IndexError>,
    E
] {
    return work_prepare_with(application(input), original_error, chain_read, inspect_plan, inspect_all) with {
        HarnessWorkStage.write(name, state) => stage_log(name, state);
        HarnessProgress.write(line) => println(line);
        DiagnosticOutput.write(line) => println(line);
    };
}

public flow prepare_unicode<effect E>(
    input: Work,
    original_error: (string) -> string ![],
    stage_log: (string, WorkLedger) -> unit ![E]
) -> Result<Pending, Failure> ![
    Console,
    LegacyStringStages,
    LegacyEditStages,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Error<fs_IOError>,
    Error<IOError>,
    Error<IndexError>,
    E
] {
    return work_prepare_unicode(application(input), original_error) with {
        HarnessWorkStage.write(name, state) => stage_log(name, state);
        EditOriginal.read(path) => read_original(path);
        HarnessProgress.write(line) => println(line);
        DiagnosticOutput.write(line) => println(line);
    };
}

public flow prepare_expanded_unicode<effect E>(
    input: Work,
    original_error: (string) -> string ![],
    stage_log: (string, WorkLedger) -> unit ![E],
    wide: bool
) -> Result<Pending, Failure> ![
    Console,
    LegacyStringStages,
    LegacyEditStages,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Error<fs_IOError>,
    Error<IOError>,
    Error<IndexError>,
    E
] {
    return work_prepare_expanded_unicode(application(input), original_error, wide, false) with {
        HarnessWorkStage.write(name, state) => stage_log(name, state);
        EditOriginal.read(path) => read_original_wide(path);
        HarnessProgress.write(line) => println(line);
        DiagnosticOutput.write(line) => println(line);
    };
}

public flow expanded_stage(name: string, state: WorkLedger, wide: bool) -> unit {
    println("STAGE " + name);
    expanded_ledger(state, wide);
}

public flow prepare<effect E>(
    input: Work,
    original_error: (string) -> string ![],
    stage_log: (string, WorkLedger) -> unit ![E],
    chain_read: bool,
    inspect_plan: bool,
    inspect_all: bool
) -> Result<Pending, Failure> ![
    Console,
    LegacyStringStages,
    LegacyEditStages,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Error<fs_IOError>,
    Error<IOError>,
    Error<IndexError>,
    E
] {
    return prepare_with<![E]>(input, original_error, stage_log, chain_read, inspect_plan, inspect_all) with {
        EditOriginal.read(path) => read_original(path);
    };
}

public flow prepare_work(input: Work) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => "";
    let log: (string, WorkLedger) -> unit ![Error<IOError>] = (
        name: string,
        state: WorkLedger
    ) => harness_work_entry_stage(name, state);
    return prepare<![Error<IOError>]>(input, original, log, false, false, false) with {
        LegacyStringStages.main(value) => read_main(value);
        LegacyStringStages.child(task, files, selected) => ascii_read_work_child_turn(task, files, selected);
        LegacyEditStages.plan(value) => edit_plan(value);
        LegacyEditStages.child(value) => edit_child(value);
        LegacyEditStages.aggregate(value) => harness_work_model_aggregate(value);
    };
}

flow prepare_chain_mode(
    input: Work,
    parent: Array<ParentFacts>,
    expected: Option<string>,
    inspect_plan: bool,
    inspect_all: bool,
    user_context: bool
) -> Result<Pending, Failure> {
    let original: (string) -> string ![] = (value: string) => match expected {
        Some(before) => if value == before {
            ""
        } else {
            "current original differs from confirmed parent result"
        },
        None() => ""
    };
    let log: (string, WorkLedger) -> unit ![Error<IOError>] = (
        name: string,
        state: WorkLedger
    ) => chain_stage(name, state, user_context);
    return prepare<![Error<IOError>]>(input, original, log, true, inspect_plan, inspect_all) with {
        LegacyStringStages.main(value) => read_main(value);
        LegacyStringStages.child(task, files, selected) => chain_child_turn(
            task,
            files,
            selected,
            inspect_all
        );
        LegacyEditStages.plan(value) => work_plan(value, parent);
        LegacyEditStages.child(value) => child(value, parent);
        LegacyEditStages.aggregate(value) => work_chain_model_aggregate(value, parent);
    };
}

public flow prepare_chain_work(
    input: Work,
    parent: Array<ParentFacts>,
    expected: Option<string>,
    inspect_plan: bool,
    inspect_all: bool
) -> Result<Pending, Failure> {
    return prepare_chain_mode(input, parent, expected, inspect_plan, inspect_all, false);
}

public flow prepare_user_context_work(
    input: Work,
    parent: Array<ParentFacts>,
    expected: Option<string>,
    inspect_plan: bool,
    inspect_all: bool
) -> Result<Pending, Failure> {
    return prepare_chain_mode(input, parent, expected, inspect_plan, inspect_all, true);
}

public flow completed_context_work(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    return complete(pending, outcome);
}

public flow finish_edit(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    recorded(pending.selected);
    return complete(pending, outcome);
}

public flow finish_summary<effect E>(
    completed: Completed,
    stage_log: (string, WorkLedger) -> unit ![E],
    work: bool,
    inspect_all: bool
) -> Result<Summary, Failure> ![Console, LegacyEditStages, Error<IOError>, Error<IndexError>, E] {
    return work_finish_summary(completed, work, inspect_all) with {
        HarnessWorkStage.write(name, state) => stage_log(name, state);
        HarnessProgress.write(line) => println(line);
        DiagnosticOutput.write(line) => println(line);
    };
}

public flow finish_history_summary<effect E>(
    completed: Completed,
    stage_log: (string, WorkLedger) -> unit ![E]
) -> Result<Summary, Failure> ![Console, LegacyEditStages, Error<IOError>, Error<IndexError>, E] {
    return work_finish_history_summary(completed) with {
        HarnessWorkStage.write(name, state) => stage_log(name, state);
        HarnessProgress.write(line) => println(line);
        DiagnosticOutput.write(line) => println(line);
    };
}

public flow summarize(completed: Completed) -> Result<Summary, Failure> {
    let log: (string, WorkLedger) -> unit ![Error<IOError>] = (
        name: string,
        state: WorkLedger
    ) => harness_work_entry_stage(name, state);
    return finish_summary<![Error<IOError>]>(completed, log, false, false) with {
        LegacyEditStages.plan(value) => edit_plan(value);
        LegacyEditStages.child(value) => edit_child(value);
        LegacyEditStages.aggregate(value) => harness_work_model_aggregate(value);
    };
}

flow summarize_chain_mode(
    completed: Completed,
    parent: Array<ParentFacts>,
    inspect_all: bool,
    user_context: bool
) -> Result<Summary, Failure> {
    let log: (string, WorkLedger) -> unit ![Error<IOError>] = (
        name: string,
        state: WorkLedger
    ) => chain_stage(name, state, user_context);
    return finish_summary<![Error<IOError>]>(completed, log, true, inspect_all) with {
        LegacyEditStages.plan(value) => work_plan(value, parent);
        LegacyEditStages.child(value) => child(value, parent);
        LegacyEditStages.aggregate(value) => work_chain_model_aggregate(value, parent);
    };
}

public flow summarize_chain(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<
    Summary,
    Failure
> {
    return summarize_chain_mode(completed, parent, inspect_all, false);
}

public flow summarize_user_context(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<
    Summary,
    Failure
> {
    return summarize_chain_mode(completed, parent, inspect_all, true);
}

public flow harness_work_entry_run(args: Array<string>) -> i32 ![
    Console,
    Memory,
    ports_Approval,
    Fs.read<ReadOnlyRoot>,
    Fs.stat<EditableRoot>,
    Fs.read<EditableRoot>,
    Fs.atomic_replace<EditableRoot>,
    Error<StorageError>,
    Error<IndexError>,
    Error<IOError>,
    Error<fs_IOError>,
    Error<BudgetExceeded>
] {
    let input = match harness_work_args_parse(args) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(work_fresh(), error);
        }
    };
    if input.edit.help {
        harness_work_entry_help();
        return 0;
    }
    match edit_operation_store_available() {
        Ok(_) => (),
        Err(error) => {
            return harness_work_entry_refused(work_fresh(), error);
        }
    }
    let pending = match prepare_work(input) {
        Ok(value) => value,
        Err(failure) => {
            return harness_work_entry_refused(failure.state, failure.error);
        }
    };
    let outcome = match execute(pending.selected, pending.prepared) {
        Ok(value) => value,
        Err(error) => {
            return harness_work_entry_refused(pending.state, error);
        }
    };
    let completed = match finish_edit(pending, outcome) {
        Ok(value) => value,
        Err(failure) => {
            return harness_work_entry_refused(failure.state, failure.error);
        }
    };
    let summary = match summarize(completed) {
        Ok(value) => value,
        Err(failure) => {
            return harness_work_entry_refused(failure.state, failure.error);
        }
    };
    display("FINAL ", summary.answer);
    console_ledger(summary.state);
    return 0;
}

public flow read_model_tools_chat_run(args: Array<string>) -> i32 {
    return run_mode(args, true);
}

flow read_model_tools_entry_help() -> unit {
    println("Nomo model/tool harness: new --once TEXT --allow FILE[,FILE...] (either flag order).");
    println("Raw request/task 1..65536, child 1..1048576, final 1..1048576 safe UTF-8 bytes; 1..4 paths of <=128 UTF-8 bytes, raw allowlist <=195 bytes.");
    println("Shared maximum: 7 steps / 4 model calls / 8192 token allowance / 1 read-or-search / 16384 scan allowance; not measured usage.");
    println("Complete model context <=2048. Read size checked after reading. One fresh serial child; no writes, commands, resume, line mode or persistence. Host aborts may leave reservations unresolved.");
}

public flow read_model_tools_entry_run(args: Array<string>) -> i32 {
    if args.len() == 0 || args.len() > 7 {
        return unicode_read_refused(read_fresh(), "expected bounded new --once TEXT --allow FILE[,FILE...]");
    }
    let extracted = match extract_allow(args, true) {
        Ok(value) => value,
        Err(error) => {
            return unicode_read_refused(read_fresh(), error);
        }
    };
    let request = match read_cli_parse_args(extracted.remaining) {
        Ok(value) => value,
        Err(error) => {
            return unicode_read_refused(read_fresh(), error);
        }
    };
    if request.is_help() {
        if extracted.supplied {
            return unicode_read_refused(read_fresh(), "help must be used alone");
        }
        read_model_tools_entry_help();
        return 0;
    }
    if !request.is_new() {
        return unicode_read_refused(read_fresh(), "resume is unavailable in the model/tool harness");
    }
    if request.once() == None() {
        return unicode_read_refused(read_fresh(), "this entry requires new --once TEXT");
    }
    if !extracted.supplied {
        return unicode_read_refused(read_fresh(), "this entry requires --allow FILE[,FILE...]");
    }
    return unicode_read_run(request.once().unwrap(), split(extracted.allowed, ","));
}
