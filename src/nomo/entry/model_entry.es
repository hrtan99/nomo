module nomo.entry.model_entry;

import std.io.{println, read_line};
import std.text.{trim, char_count as len};
import nomo.cli.config.load_for;
import nomo.core.conversation.fresh;
import nomo.agent.provider.model_turn;
import nomo.agent.loop.reject;

flow model_help() -> unit {
    println("Nomo model: --flow model --profile gateway-qwen --args --model qwen [--once TEXT]");
    println("Text only; model output never dispatches tools. /help, /exit, EOF; 16 input lines.");
    println("Input: 1024 raw characters; output: 512 raw characters, printable ASCII after trimming.");
    println("Context: 2048-character conservative encoded-data bound; history: 32 events / 8192 content characters.");
    println("--steps and --budget: 1..16; one attempt per turn, at most four calls / 8192 reserved tokens per invocation.");
    println("Each call has 2048 input+output tokens; gateway deadlines 120000/2000 ms, retry attempts 1.");
    println("Host failures may abort the invocation. No persistence, resume, tools or graceful cancellation.");
}

public flow run_model(args: Array<string>) -> i32 {
    let config = load_for(args, "qwen");
    if config.error != "" { println("error: " + config.error); abort("Nomo model configuration rejected"); }
    if config.help { model_help(); return 0; }
    var state = fresh();
    if config.once {
        let outcome = model_turn(config.request, config.steps, config.budget, state);
        if outcome.status != 0 { abort("Nomo model request failed; see error event"); }
        return 0;
    }
    println("Nomo model (qwen, text-only, fresh in-memory invocation). /help or /exit.");
    var lines: i32 = 0;
    while lines < 16 limit Iterations(16) {
        let input = read_line();
        if input == "" { println("bye: EOF"); return 0; }
        lines = lines + 1;
        if len(input) > 1024 { let outcome = reject(state, "input exceeds 1024 characters"); state = outcome.state; }
        else {
            let command = trim(input);
            if command == "/exit" { println("bye: exit"); return 0; }
            if command == "/help" { model_help(); }
            else { let outcome = model_turn(input, config.steps, config.budget, state); state = outcome.state; }
        }
        if state.stopped { abort("Nomo model history capacity exhausted"); }
    }
    let outcome = reject(state, "line limit reached; start a new in-memory invocation");
    state = outcome.state;
    abort("Nomo model line limit exhausted");
}
