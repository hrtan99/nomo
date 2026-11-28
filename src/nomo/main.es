module nomo.main;

import nomo.adapters.cli.chains.{
    help as chains_help,
    recovery_decision_run,
    run_continue as chains_run_continue,
    run_inspect,
    run_new as chains_run_new,
    run_observed_continue,
    run_observed_new,
    run_sessions,
    user_context_entry_run,
    work_chain_sessions_run_show
};
import nomo.adapters.cli.chat.{
    read_session_run,
    read_session_status as chat_read_session_status,
    recoverable_read_session_run,
    recoverable_read_session_status
};
import nomo.adapters.cli.checkpoints.{
    harness_checkpoint_entry_run_init,
    harness_checkpoint_entry_run_show,
    harness_successor_entry_run_show,
    run_continue,
    run_help as checkpoints_run_help,
    run_new,
    run_resume,
    run_save as checkpoints_run_save,
    session_lifecycle_run_init,
    session_lifecycle_run_show
};
import nomo.adapters.cli.checks.{
    history_check_run,
    history_followup_check_run,
    recoverable_history_check_run,
    recoverable_history_followup_check_run
};
import nomo.adapters.cli.editing.{run_apply, run_help, run_status};
import nomo.adapters.cli.followup.{abandon as followup_abandon, history_followup_run, recoverable_history_followup_run};
import nomo.adapters.cli.harness.{
    harness_chat_run,
    harness_edit_entry_run,
    harness_entry_run,
    harness_model_entry_run,
    harness_model_tools_chat_run,
    harness_model_tools_entry_run,
    harness_work_entry_run,
    read_model_tools_chat_run,
    read_model_tools_entry_run
};
import nomo.adapters.cli.input.load;
import nomo.adapters.cli.model.{run_model, run_model_tools, run_tools};
import nomo.adapters.cli.state.demo;
import nomo.adapters.cli.terminal.{help as terminal_help_2, run, run_once};
import nomo.adapters.cli.work.{abandon, history_work_run, recoverable_history_work_run, run_save, run_show};
import nomo.bootstrap.harness.{reject, turn};
import nomo.bootstrap.main.{main_run, native_migration_run, project};
import nomo.domain.conversation.{EntryMode, fresh};
import nomo.domain.limits.request_bytes;
import std.io.{println, read_line};
import std.text.{char_count, trim};

// The runtime returns i32 as data; every command uses this same OS-failure boundary.
flow completed(status: i32, message: string) -> i32 {
    if status != 0 {
        abort(message);
    }
    return status;
}

flow native_project(args: Array<string>) -> i32 {
    return completed(main_run(args, EntryMode.Interactive), "Nomo native project stopped");
}

flow native_attach(args: Array<string>) -> i32 {
    return completed(main_run(args, EntryMode.Attach), "Nomo native startup selection stopped");
}

flow native_state_migrate(args: Array<string>) -> i32 {
    return completed(native_migration_run(args), "Nomo native state migration stopped");
}

flow project_state_migrate(args: Array<string>) -> i32 {
    return completed(project(args), "Nomo project state migration stopped");
}

flow terminal(args: Array<string>) -> i32 {
    return completed(run(args), "Nomo terminal stopped; inspect current journal and work state");
}

flow terminal_once(args: Array<string>) -> i32 {
    return completed(run_once(args), "Nomo one-shot terminal stopped; inspect current journal and work state");
}

flow terminal_help(args: Array<string>) -> i32 {
    return completed(terminal_help_2(args), "Nomo terminal help refused; see REFUSED output");
}

flow work_save(args: Array<string>) -> i32 {
    return completed(
        run_save(args),
        "Nomo work save refused; see completed edit and work record status output"
    );
}

flow work_show(args: Array<string>) -> i32 {
    return completed(run_show(args), "Nomo work show refused; see REFUSED output");
}

flow harness_work(args: Array<string>) -> i32 {
    return completed(
        harness_work_entry_run(args),
        "Nomo read/edit work refused; see REFUSED or recorded completed output"
    );
}

flow harness_edit(args: Array<string>) -> i32 {
    return completed(
        harness_edit_entry_run(args),
        "Nomo model edit refused; see REFUSED or recorded completed output"
    );
}

flow edit_apply(args: Array<string>) -> i32 {
    return completed(run_apply(args), "Nomo edit apply refused; see REFUSED output");
}

flow edit_status(args: Array<string>) -> i32 {
    return completed(run_status(args), "Nomo edit status refused; see REFUSED output");
}

flow edit_help(args: Array<string>) -> i32 {
    return completed(run_help(args), "Nomo edit help refused; see REFUSED output");
}

flow help(args: Array<string>) -> i32 {
    return completed(checkpoints_run_help(args), "Nomo session help refused; see REFUSED output");
}

flow init(args: Array<string>) -> i32 {
    return completed(session_lifecycle_run_init(args), "Nomo session init refused; see REFUSED output");
}

flow new(args: Array<string>) -> i32 {
    return completed(run_new(args), "Nomo session new refused; see REFUSED output");
}

flow resume(args: Array<string>) -> i32 {
    return completed(run_resume(args), "Nomo session resume refused; see REFUSED output");
}

flow show(args: Array<string>) -> i32 {
    return completed(session_lifecycle_run_show(args), "Nomo session show refused; see REFUSED output");
}

flow harness_checkpoint_continue(args: Array<string>) -> i32 {
    return completed(run_continue(args), "Nomo Harness checkpoint continue refused; see REFUSED output");
}

flow harness_successor_show(args: Array<string>) -> i32 {
    return completed(
        harness_successor_entry_run_show(args),
        "Nomo Harness successor show refused; see REFUSED output"
    );
}

flow harness_checkpoint_init(args: Array<string>) -> i32 {
    return completed(
        harness_checkpoint_entry_run_init(args),
        "Nomo Harness checkpoint init refused; see REFUSED output"
    );
}

flow harness_checkpoint_save(args: Array<string>) -> i32 {
    return completed(checkpoints_run_save(args), "Nomo Harness checkpoint save refused; see REFUSED output");
}

flow harness_checkpoint_show(args: Array<string>) -> i32 {
    return completed(
        harness_checkpoint_entry_run_show(args),
        "Nomo Harness checkpoint show refused; see REFUSED output"
    );
}

flow harness_model_tools_chat(args: Array<string>) -> i32 {
    return completed(
        harness_model_tools_chat_run(args),
        "Nomo model/tool harness chat refused; see REFUSED or STOP output"
    );
}

flow read_session_status(args: Array<string>) -> i32 {
    return completed(chat_read_session_status(args), "Nomo read session status refused");
}

flow recovery_decision(args: Array<string>) -> i32 {
    return completed(recovery_decision_run(args), "Nomo recovery decision stopped; inspect recorded status");
}

flow history_check(args: Array<string>) -> i32 {
    return completed(history_check_run(args), "Nomo history check stopped; inspect recorded status");
}

flow history_work(args: Array<string>) -> i32 {
    return completed(history_work_run(args), "Nomo history work stopped; inspect recorded edit status");
}

flow recoverable_work_abandon(args: Array<string>) -> i32 {
    return completed(abandon(args), "Nomo recovery decision refused");
}

flow recoverable_history_work(args: Array<string>) -> i32 {
    return completed(
        recoverable_history_work_run(args),
        "Nomo event work stopped; inspect recorded edit status"
    );
}

flow recoverable_followup_abandon(args: Array<string>) -> i32 {
    return completed(followup_abandon(args), "Nomo recovery decision refused");
}

flow recoverable_history_followup(args: Array<string>) -> i32 {
    return completed(
        recoverable_history_followup_run(args),
        "Nomo event followup stopped; inspect recorded edit status"
    );
}

flow recoverable_history_followup_check(args: Array<string>) -> i32 {
    return completed(
        recoverable_history_followup_check_run(args),
        "Nomo event followup check stopped; inspect recorded status"
    );
}

flow recoverable_history_check(args: Array<string>) -> i32 {
    return completed(recoverable_history_check_run(args), "Nomo event check stopped; inspect recorded status");
}

flow read_session(args: Array<string>) -> i32 {
    return completed(read_session_run(args), "Nomo read session stopped; inspect the saved reservation");
}

flow recoverable_read_session(args: Array<string>) -> i32 {
    return completed(
        recoverable_read_session_run(args),
        "Nomo recoverable read session stopped; inspect recorded state"
    );
}

flow recoverable_read_status(args: Array<string>) -> i32 {
    return completed(recoverable_read_session_status(args), "Nomo recoverable read status refused");
}

flow read_model_tools_chat(args: Array<string>) -> i32 {
    return completed(read_model_tools_chat_run(args), "Nomo read chat refused; see REFUSED or STOP output");
}

flow read_model_tools(args: Array<string>) -> i32 {
    return completed(read_model_tools_entry_run(args), "Nomo read request refused; see REFUSED output");
}

flow harness_model_tools(args: Array<string>) -> i32 {
    return completed(
        harness_model_tools_entry_run(args),
        "Nomo model/tool harness refused; see REFUSED output"
    );
}

flow harness_model(args: Array<string>) -> i32 {
    return completed(harness_model_entry_run(args), "Nomo model harness refused; see REFUSED output");
}

flow harness_chat(args: Array<string>) -> i32 {
    return completed(harness_chat_run(args), "Nomo harness chat refused; see REFUSED or STOP output");
}

// Preserve the established opt-in wrapper's nonzero-result -> OS failure route.
flow harness(args: Array<string>) -> i32 {
    return completed(harness_entry_run(args), "Nomo harness request refused; see REFUSED output");
}

flow model_tools(args: Array<string>) -> i32 {
    return run_model_tools(args);
}

// Convert the opt-in handler's typed refusal into a failing CLI process.
// The Etas CLI itself does not map a returned i32 to an OS exit status.
flow session(args: Array<string>) -> i32 {
    return completed(demo(args), "Nomo session demo refused; see REFUSED output");
}

flow tools(args: Array<string>) -> i32 {
    return run_tools(args);
}

flow foundation_help() -> unit {
    println("Nomo foundation: --model stub --steps 1..16 --budget 1..16 [--once TEXT]");
    println("Line mode: /help, /exit; at most 16 input lines; no prompt escapes.");
    println("Input: printable ASCII, at most 1024 characters; steps: canonical decimal 1..16.");
    println("Stub: plain text or tool:echo:TEXT; stub:fail / tool:echo:fail simulate failures.");
    println("Each model call and fake-tool dispatch costs one step; echo round trip needs 3.");
    println("Limits: per-turn steps default 3; cumulative invocation budget default 16; failures consume steps.");
    println("History: 32 events / 8192 content characters; reserve four events per turn plus a stop error.");
    println("Capacity reserves worst-case next-turn content before execution; no history is discarded.");
    println("recall reads the latest completed tool result; recall:user reads prior input. No tool redispatch.");
    println("New process = fresh non-durable conversation, never resume.");
    println("Unavailable in stub entry: persistence, resume, live models, real tools, graceful active-turn cancellation.");
    println("Opt-in model entry: --flow model --profile gateway-qwen --args --model qwen.");
}

flow model(args: Array<string>) -> i32 {
    return run_model(args);
}

flow main(args: Array<string>) -> i32 {
    let config = load(args);
    if config.error != "" {
        println("error: " + config.error);
        abort("Nomo configuration rejected");
    }
    if config.help {
        foundation_help();
        return 0;
    }
    var state = fresh();
    if config.once {
        let outcome = turn(config.request, config.steps, config.budget, state);
        if outcome.status != 0 {
            abort("Nomo request failed; see error event");
        }
        return 0;
    }
    println("Nomo foundation (stub, in-memory). /help for limits; /exit to quit.");
    var lines: i32 = 0;
    @limits([Iterations(16)]) while lines < 16 {
        let input = read_line();
        if input == "" {
            println("bye: EOF");
            return 0;
        }
        lines = lines + 1;
        if char_count(input) > request_bytes() {
            let outcome = reject(state, "input exceeds 65536 characters");
            state = outcome.state;
        }
        else {
            let command = trim(input);
            if command == "/exit" {
                println("bye: exit");
                return 0;
            }
            if command == "/help" {
                foundation_help();
            }
            else {
                let outcome = turn(input, config.steps, config.budget, state);
                state = outcome.state;
            }
        }
        if state.stopped {
            abort("Nomo history capacity exhausted");
        }
    }
    let outcome = reject(state, "line limit reached; start a new in-memory invocation");
    state = outcome.state;
    abort("Nomo line limit exhausted");
}

flow chain_new(args: Array<string>) -> i32 {
    return completed(chains_run_new(args), "Nomo v2 chain new refused; see admission/journal status");
}

flow chain_user_context_new(args: Array<string>) -> i32 {
    return completed(
        user_context_entry_run(args),
        "Nomo user-context work stopped; inspect admission/journal status"
    );
}

flow chain_continue(args: Array<string>) -> i32 {
    return completed(chains_run_continue(args), "Nomo v2 continuation refused; see admission/journal status");
}

flow chain_show(args: Array<string>) -> i32 {
    return completed(work_chain_sessions_run_show(args), "Nomo v2 show refused; see REFUSED");
}

flow chain_help(args: Array<string>) -> i32 {
    return completed(chains_help(args), "Nomo chain help refused; see REFUSED");
}

flow chain_inspect(args: Array<string>) -> i32 {
    return completed(run_inspect(args), "Nomo fixture read-plan inspection stopped; no retry or edit");
}

flow chain_observe_new(args: Array<string>) -> i32 {
    return completed(run_observed_new(args), "Nomo observed fixture new refused; preserve state, no retry");
}

flow chain_observe_continue(args: Array<string>) -> i32 {
    return completed(
        run_observed_continue(args),
        "Nomo observed fixture continuation refused; preserve state, no retry"
    );
}

flow chain_sessions(args: Array<string>) -> i32 {
    return completed(run_sessions(args), "Nomo session discovery refused; see REFUSED");
}

flow history_followup(args: Array<string>) -> i32 {
    return completed(history_followup_run(args), "Nomo followup stopped; inspect recorded status");
}

flow history_followup_check(args: Array<string>) -> i32 {
    return completed(history_followup_check_run(args), "Nomo followup check stopped; inspect recorded status");
}
