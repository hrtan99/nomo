module nomo.entry.model_tool_entry;

import std.collections.len;
import std.text.split;
import std.text.len as text_len;
import std.io.println;
import nomo.cli.config.load_for;
import nomo.model.model_tool_contract.{Limits, fresh_loop};
import nomo.agent.model_tool.run_loop;

public flow run_model_tools(args: Array<string>) -> i32 {
    if len(args) > 10 { println("error: too many arguments"); abort("model-tool configuration rejected"); }
    var forwarded: Array<string> = [];
    var allowed: Array<string> = [];
    var seen = false;
    var index: usize = 0;
    while index < len(args) limit Iterations(10) {
        if args[index] == "--allow" {
            if seen || index + 1 >= len(args) { println("error: invalid or duplicate --allow"); abort("model-tool configuration rejected"); }
            if text_len(args[index + 1]) > 97 { println("error: allowed names exceed 97 characters"); abort("model-tool configuration rejected"); }
            seen = true;
            allowed = split(args[index + 1], ",");
            index = index + 2;
        } else {
            forwarded = forwarded.push(args[index]);
            if args[index] != "--help" && index + 1 < len(args) {
                forwarded = forwarded.push(args[index + 1]);
                index = index + 1;
            }
            index = index + 1;
        }
    }
    let config = load_for(forwarded, "qwen-tools");
    if config.error != "" { println("error: " + config.error); abort("model-tool configuration rejected"); }
    if config.help {
        if seen { println("error: --help must be used alone"); abort("model-tool configuration rejected"); }
        println("Opt-in model_tools: --model qwen-tools --allow FILE[,FILE] --once QUESTION [--steps N] [--budget N]");
        println("Requires gateway-qwen-readonly profile and dedicated immutable synthetic read-only fixture; no arbitrary repository.");
        println("Question: 1..128 printable ASCII chars; 1..2 distinct allowed paths, each at most 48 chars.");
        println("At most 3 total steps, 2 model calls / 4096 reserved tokens, 1 tool / 4096 reserved scan bytes; no refunds or retry.");
        println("Read or literal search only; complete display result <=256 chars, final <=512 chars, full model data context <=2048 chars.");
        println("One shot, no persistence/resume. Host failure aborts; it does not produce a durable/recoverable outcome.");
        return 0;
    }
    if !seen || !config.once { println("error: model-tool entry requires --allow and --once"); abort("model-tool configuration rejected"); }
    var steps = config.steps;
    if config.budget < steps { steps = config.budget; }
    let limits = Limits { steps = steps, calls = 2, tokens = 4096, scan = 4096 };
    let result = run_loop(config.request, allowed, limits, fresh_loop());
    if result.status != 0 { abort("model-tool turn failed; see outcome"); }
    return 0;
}
