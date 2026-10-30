module nomo.main;

import std.io.{println, read_line};
import std.text.{trim, len};
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
import nomo.entry.harness_model_tools_chat.run as run_harness_model_tools_chat;
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

flow terminal(args: Array<string>) -> i32 {
    let status = terminal_run(args);
    if status != 0 { abort("Nomo terminal stopped; inspect current journal and work state"); }
    return 0;
}
flow terminal_once(args: Array<string>) -> i32 {
    let status = terminal_once_run(args);
    if status != 0 { abort("Nomo one-shot terminal stopped; inspect current journal and work state"); }
    return 0;
}
flow terminal_help(args: Array<string>) -> i32 {
    let status = terminal_help_run(args);
    if status != 0 { abort("Nomo terminal help refused; see REFUSED output"); }
    return 0;
}

flow work_save(args: Array<string>) -> i32 {
    let status = work_save_run(args);
    if status != 0 { abort("Nomo work save refused; see completed edit and work record status output"); }
    return 0;
}
flow work_show(args: Array<string>) -> i32 {
    let status = work_show_run(args);
    if status != 0 { abort("Nomo work show refused; see REFUSED output"); }
    return 0;
}

flow harness_work(args: Array<string>) -> i32 {
    let status = harness_work_run(args);
    if status != 0 { abort("Nomo read/edit work refused; see REFUSED or recorded completed output"); }
    return 0;
}

flow harness_edit(args: Array<string>) -> i32 {
    let status = harness_edit_run(args);
    if status != 0 { abort("Nomo model edit refused; see REFUSED or recorded completed output"); }
    return 0;
}

flow edit_apply(args: Array<string>) -> i32 {
    let status = edit_apply_run(args);
    if status != 0 { abort("Nomo edit apply refused; see REFUSED output"); }
    return 0;
}
flow edit_status(args: Array<string>) -> i32 {
    let status = edit_status_run(args);
    if status != 0 { abort("Nomo edit status refused; see REFUSED output"); }
    return 0;
}
flow edit_help(args: Array<string>) -> i32 {
    let status = edit_help_run(args);
    if status != 0 { abort("Nomo edit help refused; see REFUSED output"); }
    return 0;
}

flow help(args: Array<string>) -> i32 {
    let status = lifecycle_help(args);
    if status != 0 { abort("Nomo session help refused; see REFUSED output"); }
    return 0;
}
flow init(args: Array<string>) -> i32 {
    let status = lifecycle_init(args);
    if status != 0 { abort("Nomo session init refused; see REFUSED output"); }
    return 0;
}
flow new(args: Array<string>) -> i32 {
    let status = lifecycle_new(args);
    if status != 0 { abort("Nomo session new refused; see REFUSED output"); }
    return 0;
}
flow resume(args: Array<string>) -> i32 {
    let status = lifecycle_resume(args);
    if status != 0 { abort("Nomo session resume refused; see REFUSED output"); }
    return 0;
}
flow show(args: Array<string>) -> i32 {
    let status = lifecycle_show(args);
    if status != 0 { abort("Nomo session show refused; see REFUSED output"); }
    return 0;
}

flow harness_checkpoint_continue(args: Array<string>) -> i32 {
    let status = checkpoint_continue(args);
    if status != 0 { abort("Nomo Harness checkpoint continue refused; see REFUSED output"); }
    return 0;
}

flow harness_successor_show(args: Array<string>) -> i32 {
    let status = successor_show(args);
    if status != 0 { abort("Nomo Harness successor show refused; see REFUSED output"); }
    return 0;
}

flow harness_checkpoint_init(args: Array<string>) -> i32 {
    let status = checkpoint_init(args);
    if status != 0 { abort("Nomo Harness checkpoint init refused; see REFUSED output"); }
    return 0;
}

flow harness_checkpoint_save(args: Array<string>) -> i32 {
    let status = checkpoint_save(args);
    if status != 0 { abort("Nomo Harness checkpoint save refused; see REFUSED output"); }
    return 0;
}

flow harness_checkpoint_show(args: Array<string>) -> i32 {
    let status = checkpoint_show(args);
    if status != 0 { abort("Nomo Harness checkpoint show refused; see REFUSED output"); }
    return 0;
}

flow harness_model_tools_chat(args: Array<string>) -> i32 {
    let status = run_harness_model_tools_chat(args);
    if status != 0 { abort("Nomo model/tool harness chat refused; see REFUSED or STOP output"); }
    return 0;
}

flow harness_model_tools(args: Array<string>) -> i32 {
    let status = run_harness_model_tools(args);
    if status != 0 { abort("Nomo model/tool harness refused; see REFUSED output"); }
    return 0;
}

flow harness_model(args: Array<string>) -> i32 {
    let status = run_harness_model(args);
    if status != 0 { abort("Nomo model harness refused; see REFUSED output"); }
    return 0;
}

flow harness_chat(args: Array<string>) -> i32 {
    let status = run_harness_chat(args);
    if status != 0 { abort("Nomo harness chat refused; see REFUSED or STOP output"); }
    return 0;
}

// Preserve the established opt-in wrapper's nonzero-result -> OS failure route.
flow harness(args: Array<string>) -> i32 {
    let status = run_harness(args);
    if status != 0 { abort("Nomo harness request refused; see REFUSED output"); }
    return 0;
}

flow model_tools(args: Array<string>) -> i32 {
    return run_model_tools(args);
}

// Convert the opt-in handler's typed refusal into a failing CLI process.
// The Etas CLI itself does not map a returned i32 to an OS exit status.
flow session(args: Array<string>) -> i32 {
    let status = demo(args);
    if status != 0 { abort("Nomo session demo refused; see REFUSED output"); }
    return 0;
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
        if len(input) > 1024 { let outcome = reject(state, "input exceeds 1024 characters"); state = outcome.state; }
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

flow chain_new(args: Array<string>) -> i32 { let status = chain_new_run(args); if status != 0 { abort("Nomo v2 chain new refused; see admission/journal status"); } return 0; }
flow chain_user_context_new(args: Array<string>) -> i32 { let status = user_context_new_run(args); if status != 0 { abort("Nomo user-context work stopped; inspect admission/journal status"); } return 0; }
flow chain_continue(args: Array<string>) -> i32 { let status = chain_continue_run(args); if status != 0 { abort("Nomo v2 continuation refused; see admission/journal status"); } return 0; }
flow chain_show(args: Array<string>) -> i32 { let status = chain_show_run(args); if status != 0 { abort("Nomo v2 show refused; see REFUSED"); } return 0; }

flow chain_help(args: Array<string>) -> i32 { let status = chain_help_run(args); if status != 0 { abort("Nomo chain help refused; see REFUSED"); } return 0; }

flow chain_inspect(args: Array<string>) -> i32 { let status = chain_inspect_run(args); if status != 0 { abort("Nomo fixture read-plan inspection stopped; no retry or edit"); } return 0; }

flow chain_observe_new(args: Array<string>) -> i32 { let status = chain_observed_new_run(args); if status != 0 { abort("Nomo observed fixture new refused; preserve state, no retry"); } return 0; }
flow chain_observe_continue(args: Array<string>) -> i32 { let status = chain_observed_continue_run(args); if status != 0 { abort("Nomo observed fixture continuation refused; preserve state, no retry"); } return 0; }

flow chain_sessions(args: Array<string>) -> i32 { let status = chain_sessions_run(args); if status != 0 { abort("Nomo session discovery refused; see REFUSED"); } return 0; }
