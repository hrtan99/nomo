module nomo.entry.recoverable_history_check;

import std.io.{println, read_line};
import std.json.parse;
import std.collections.len as count;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.io.IOError as ConsoleError;
import nomo.session.event_policy.{PolicyRoot, load as load_policy};
import nomo.application.check_contract.{CheckResult, CheckLifecycle};
import nomo.session.check_lifecycle.{FirstCheck, FollowupCheck, ContinuousCheck};
import nomo.session.redaction.Policy;
import nomo.session.recoverable_chat_store.record_check;
import nomo.session.continuous_work.load as load_extra;

// Called only by the launcher while it retains the session lock. No model or
// workspace capability is granted to this checkpoint process.
public flow run_mode(args: Array<string>, followup: bool) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) < 4 || args[0] != "--policy-binding" { println("REFUSED check policy binding required"); return 1; }
    let policy = match load_policy() { Ok(item) => item, Err(error) => { println("REFUSED " + error); return 1; } };
    let binding = args[1]; var additional = false;
    if followup { let extra = match load_extra(binding) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } }; match extra { Some(item) => { if item.value.current.core.id == args[3] { additional = true; } } None() => {} } }
    if additional { return run_lifecycle(ContinuousCheck { redaction = policy, binding = binding }, args, policy, binding); }
    if followup { return run_lifecycle(FollowupCheck { redaction = policy, binding = binding }, args, policy, binding); }
    return run_lifecycle(FirstCheck { redaction = policy, binding = binding }, args, policy, binding);
}

flow run_lifecycle<L ~ CheckLifecycle>(lifecycle: L, args: Array<string>, policy: Policy, binding: string) -> i32 {
    if count(args) == 5 && args[2] == "start" {
        match lifecycle.start(args[3], args[4]) { Ok(_) => { println("CHECK RESERVED"); return 0; } Err(error) => { println("REFUSED " + error); return 1; } }
    }
    if count(args) == 9 && (args[2] == "finish" || args[2] == "independent") {
        if (args[7] != "true" && args[7] != "false") || (args[8] != "true" && args[8] != "false") { println("REFUSED invalid truncation flags"); return 1; }
        let parsed = match parse(read_line()) { Ok(item) => item, _ => { println("REFUSED invalid check output transfer"); return 1; } };
        let message: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
        let fields = match message { Some(item) => item.body, None() => { println("REFUSED invalid check output fields"); return 1; } };
        if count(fields) != 2 { println("REFUSED invalid check output field count"); return 1; }
        let independent = args[2] == "independent";
        if !independent {
            let result = CheckResult { outcome = args[5], exit_code = args[6], stdout = fields[0], stderr = fields[1], stdout_truncated = args[7] == "true", stderr_truncated = args[8] == "true" };
            match lifecycle.finish(args[3], args[4], result) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
        }
        match record_check(args[3], args[4], args[5], args[6], fields[0], fields[1], args[7] == "true", args[8] == "true", independent, policy, binding) { Ok(_) => { println(if independent { "INDEPENDENT CHECK SAVED" } else { "CHECK AND SELECTED OUTPUT SAVED" }); return 0; } Err(error) => { println("REFUSED check may be saved; timeline incomplete: " + error); return 1; } }
    }
    println("REFUSED invalid check action"); return 1;
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<PolicyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return run_mode(args, false); }
