module nomo.main;

import std.io.{println, read_line};
import std.text.{trim, len};
import nomo.config.load;
import nomo.loop.{turn, reject};
import nomo.conversation.fresh;
import nomo.model_entry.run_model;
import nomo.tool_agent.run_tools;
import nomo.session_demo.demo;

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

flow help() -> unit {
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
    if config.help { help(); return 0; }
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
            if command == "/help" { help(); }
            else { let outcome = turn(input, config.steps, config.budget, state); state = outcome.state; }
        }
        if state.stopped { abort("Nomo history capacity exhausted"); }
    }
    let outcome = reject(state, "line limit reached; start a new in-memory invocation");
    state = outcome.state;
    abort("Nomo line limit exhausted");
}
