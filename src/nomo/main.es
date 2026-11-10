module nomo.main;

import nomo.core.large_context.{request_bytes};

import std.io.{println, read_line};
import std.text.{trim, char_count as len};
import nomo.cli.config.load;
import nomo.agent.loop.{turn, reject};
import nomo.core.conversation.fresh;
import nomo.entry.model_entry.run_model;
import nomo.entry.tool_agent.run_tools;
import nomo.entry.session_demo.demo;
import nomo.entry.model_tool_entry.run_model_tools;
import nomo.entry.harness_entry.run as run_harness;
import nomo.entry.harness_chat.run as run_harness_chat;
import nomo.entry.harness_model_entry.run as run_harness_model;
import nomo.entry.harness_model_tools_entry.run as run_harness_model_tools;
import nomo.entry.read_model_tools_entry.run as run_read_model_tools;
import nomo.entry.harness_model_tools_chat.run as run_harness_model_tools_chat;
import nomo.entry.read_model_tools_chat.run as run_read_model_tools_chat;
import nomo.entry.read_session.run as run_read_session;
import nomo.entry.recoverable_read_session.{run as run_recoverable_read_session, status as run_recoverable_read_status};
import nomo.entry.history_work.run as run_history_work;
import nomo.entry.recoverable_history_work.{run as run_recoverable_history_work, abandon as abandon_recoverable_work};
import nomo.entry.recoverable_history_followup.{run as run_recoverable_history_followup, abandon as abandon_recoverable_followup};
import nomo.entry.recoverable_history_followup_check.run as run_recoverable_history_followup_check;
import nomo.entry.recoverable_history_check.run as run_recoverable_history_check;
import nomo.entry.history_followup.run as run_history_followup;
import nomo.entry.history_followup_check.run as run_history_followup_check;
import nomo.entry.history_check.run as run_history_check;
import nomo.entry.recovery_decision.run as run_recovery_decision;
import nomo.entry.read_session.status as read_session_status_run;
import nomo.entry.harness_checkpoint_entry.run_init as checkpoint_init;
import nomo.entry.harness_checkpoint_entry.run_save as checkpoint_save;
import nomo.entry.harness_checkpoint_entry.run_show as checkpoint_show;
import nomo.entry.harness_successor_entry.run_continue as checkpoint_continue;
import nomo.entry.harness_successor_entry.run_show as successor_show;
import nomo.entry.session_lifecycle.run_help as lifecycle_help;
import nomo.entry.session_lifecycle.run_init as lifecycle_init;
import nomo.entry.session_lifecycle.run_new as lifecycle_new;
import nomo.entry.session_lifecycle.run_resume as lifecycle_resume;
import nomo.entry.session_lifecycle.run_show as lifecycle_show;
import nomo.entry.edit_entry.run_apply as edit_apply_run;
import nomo.entry.edit_entry.run_status as edit_status_run;
import nomo.entry.edit_entry.run_help as edit_help_run;
import nomo.entry.harness_edit_entry.run as harness_edit_run;
import nomo.entry.harness_work_entry.run as harness_work_run;
import nomo.entry.work_session_entry.{run_save as work_save_run, run_show as work_show_run};
import nomo.entry.work_chain_entry.{run_new as chain_new_run, run_continue as chain_continue_run, run_inspect as chain_inspect_run, run_observed_new as chain_observed_new_run, run_observed_continue as chain_observed_continue_run};
import nomo.entry.work_chain_help.help as chain_help_run;
import nomo.entry.terminal_entry.run as terminal_run;
import nomo.entry.terminal_entry.run_once as terminal_once_run;
import nomo.entry.terminal_help.help as terminal_help_run;
import nomo.entry.work_chain_sessions.{run_sessions as chain_sessions_run, run_show as chain_show_run};
import nomo.entry.user_context_entry.run as user_context_new_run;
import nomo.project.entry.run as project_run;

// The runtime returns i32 as data; every command uses this same OS-failure boundary.
flow completed(status: i32, message: string) -> i32 {
    if status != 0 { abort(message); }
    return status;
}

flow project_agent(args: Array<string>) -> i32 { return completed(project_run(args), "Nomo project worker stopped"); }

flow terminal(args: Array<string>) -> i32 {
    return completed(terminal_run(args), "Nomo terminal stopped; inspect current journal and work state");
}
flow terminal_once(args: Array<string>) -> i32 {
    return completed(terminal_once_run(args), "Nomo one-shot terminal stopped; inspect current journal and work state");
}
flow terminal_help(args: Array<string>) -> i32 {
    return completed(terminal_help_run(args), "Nomo terminal help refused; see REFUSED output");
}

flow work_save(args: Array<string>) -> i32 {
    return completed(work_save_run(args), "Nomo work save refused; see completed edit and work record status output");
}
flow work_show(args: Array<string>) -> i32 {
    return completed(work_show_run(args), "Nomo work show refused; see REFUSED output");
}

flow harness_work(args: Array<string>) -> i32 {
    return completed(harness_work_run(args), "Nomo read/edit work refused; see REFUSED or recorded completed output");
}

flow harness_edit(args: Array<string>) -> i32 {
    return completed(harness_edit_run(args), "Nomo model edit refused; see REFUSED or recorded completed output");
}

flow edit_apply(args: Array<string>) -> i32 {
    return completed(edit_apply_run(args), "Nomo edit apply refused; see REFUSED output");
}
flow edit_status(args: Array<string>) -> i32 {
    return completed(edit_status_run(args), "Nomo edit status refused; see REFUSED output");
}
flow edit_help(args: Array<string>) -> i32 {
    return completed(edit_help_run(args), "Nomo edit help refused; see REFUSED output");
}

flow help(args: Array<string>) -> i32 {
    return completed(lifecycle_help(args), "Nomo session help refused; see REFUSED output");
}
flow init(args: Array<string>) -> i32 {
    return completed(lifecycle_init(args), "Nomo session init refused; see REFUSED output");
}
flow new(args: Array<string>) -> i32 {
    return completed(lifecycle_new(args), "Nomo session new refused; see REFUSED output");
}
flow resume(args: Array<string>) -> i32 {
    return completed(lifecycle_resume(args), "Nomo session resume refused; see REFUSED output");
}
flow show(args: Array<string>) -> i32 {
    return completed(lifecycle_show(args), "Nomo session show refused; see REFUSED output");
}

flow harness_checkpoint_continue(args: Array<string>) -> i32 {
    return completed(checkpoint_continue(args), "Nomo Harness checkpoint continue refused; see REFUSED output");
}

flow harness_successor_show(args: Array<string>) -> i32 {
    return completed(successor_show(args), "Nomo Harness successor show refused; see REFUSED output");
}

flow harness_checkpoint_init(args: Array<string>) -> i32 {
    return completed(checkpoint_init(args), "Nomo Harness checkpoint init refused; see REFUSED output");
}

flow harness_checkpoint_save(args: Array<string>) -> i32 {
    return completed(checkpoint_save(args), "Nomo Harness checkpoint save refused; see REFUSED output");
}

flow harness_checkpoint_show(args: Array<string>) -> i32 {
    return completed(checkpoint_show(args), "Nomo Harness checkpoint show refused; see REFUSED output");
}

flow harness_model_tools_chat(args: Array<string>) -> i32 {
    return completed(run_harness_model_tools_chat(args), "Nomo model/tool harness chat refused; see REFUSED or STOP output");
}

flow read_session_status(args: Array<string>) -> i32 {
    return completed(read_session_status_run(args), "Nomo read session status refused");
}

flow recovery_decision(args: Array<string>) -> i32 {
    return completed(run_recovery_decision(args), "Nomo recovery decision stopped; inspect recorded status");
}

flow history_check(args: Array<string>) -> i32 {
    return completed(run_history_check(args), "Nomo history check stopped; inspect recorded status");
}

flow history_work(args: Array<string>) -> i32 {
    return completed(run_history_work(args), "Nomo history work stopped; inspect recorded edit status");
}

flow recoverable_work_abandon(args: Array<string>) -> i32 {
    return completed(abandon_recoverable_work(args), "Nomo recovery decision refused");
}

flow recoverable_history_work(args: Array<string>) -> i32 {
    return completed(run_recoverable_history_work(args), "Nomo event work stopped; inspect recorded edit status");
}

flow recoverable_followup_abandon(args: Array<string>) -> i32 {
    return completed(abandon_recoverable_followup(args), "Nomo recovery decision refused");
}

flow recoverable_history_followup(args: Array<string>) -> i32 {
    return completed(run_recoverable_history_followup(args), "Nomo event followup stopped; inspect recorded edit status");
}

flow recoverable_history_followup_check(args: Array<string>) -> i32 {
    return completed(run_recoverable_history_followup_check(args), "Nomo event followup check stopped; inspect recorded status");
}

flow recoverable_history_check(args: Array<string>) -> i32 {
    return completed(run_recoverable_history_check(args), "Nomo event check stopped; inspect recorded status");
}

flow read_session(args: Array<string>) -> i32 {
    return completed(run_read_session(args), "Nomo read session stopped; inspect the saved reservation");
}

flow recoverable_read_session(args: Array<string>) -> i32 {
    return completed(run_recoverable_read_session(args), "Nomo recoverable read session stopped; inspect recorded state");
}

flow recoverable_read_status(args: Array<string>) -> i32 {
    return completed(run_recoverable_read_status(args), "Nomo recoverable read status refused");
}

flow read_model_tools_chat(args: Array<string>) -> i32 {
    return completed(run_read_model_tools_chat(args), "Nomo read chat refused; see REFUSED or STOP output");
}

flow read_model_tools(args: Array<string>) -> i32 {
    return completed(run_read_model_tools(args), "Nomo read request refused; see REFUSED output");
}

flow harness_model_tools(args: Array<string>) -> i32 {
    return completed(run_harness_model_tools(args), "Nomo model/tool harness refused; see REFUSED output");
}

flow harness_model(args: Array<string>) -> i32 {
    return completed(run_harness_model(args), "Nomo model harness refused; see REFUSED output");
}

flow harness_chat(args: Array<string>) -> i32 {
    return completed(run_harness_chat(args), "Nomo harness chat refused; see REFUSED or STOP output");
}

// Preserve the established opt-in wrapper's nonzero-result -> OS failure route.
flow harness(args: Array<string>) -> i32 {
    return completed(run_harness(args), "Nomo harness request refused; see REFUSED output");
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
    if config.error != "" { println("error: " + config.error); abort("Nomo configuration rejected"); }
    if config.help { foundation_help(); return 0; }
    var state = fresh();
    if config.once {
        let outcome = turn(config.request, config.steps, config.budget, state);
        if outcome.status != 0 { abort("Nomo request failed; see error event"); }
        return 0;
    }
    println("Nomo foundation (stub, in-memory). /help for limits; /exit to quit.");
    var lines: i32 = 0;
    while lines < 16 limit Iterations(16) {
        let input = read_line();
        if input == "" { println("bye: EOF"); return 0; }
        lines = lines + 1;
        if len(input) > request_bytes() { let outcome = reject(state, "input exceeds 65536 characters"); state = outcome.state; }
        else {
            let command = trim(input);
            if command == "/exit" { println("bye: exit"); return 0; }
            if command == "/help" { foundation_help(); }
            else { let outcome = turn(input, config.steps, config.budget, state); state = outcome.state; }
        }
        if state.stopped { abort("Nomo history capacity exhausted"); }
    }
    let outcome = reject(state, "line limit reached; start a new in-memory invocation");
    state = outcome.state;
    abort("Nomo line limit exhausted");
}

flow chain_new(args: Array<string>) -> i32 { return completed(chain_new_run(args), "Nomo v2 chain new refused; see admission/journal status"); }
flow chain_user_context_new(args: Array<string>) -> i32 { return completed(user_context_new_run(args), "Nomo user-context work stopped; inspect admission/journal status"); }
flow chain_continue(args: Array<string>) -> i32 { return completed(chain_continue_run(args), "Nomo v2 continuation refused; see admission/journal status"); }
flow chain_show(args: Array<string>) -> i32 { return completed(chain_show_run(args), "Nomo v2 show refused; see REFUSED"); }

flow chain_help(args: Array<string>) -> i32 { return completed(chain_help_run(args), "Nomo chain help refused; see REFUSED"); }

flow chain_inspect(args: Array<string>) -> i32 { return completed(chain_inspect_run(args), "Nomo fixture read-plan inspection stopped; no retry or edit"); }

flow chain_observe_new(args: Array<string>) -> i32 { return completed(chain_observed_new_run(args), "Nomo observed fixture new refused; preserve state, no retry"); }
flow chain_observe_continue(args: Array<string>) -> i32 { return completed(chain_observed_continue_run(args), "Nomo observed fixture continuation refused; preserve state, no retry"); }

flow chain_sessions(args: Array<string>) -> i32 { return completed(chain_sessions_run(args), "Nomo session discovery refused; see REFUSED"); }

flow history_followup(args: Array<string>) -> i32 {
    return completed(run_history_followup(args), "Nomo followup stopped; inspect recorded status");
}

flow history_followup_check(args: Array<string>) -> i32 {
    return completed(run_history_followup_check(args), "Nomo followup check stopped; inspect recorded status");
}
