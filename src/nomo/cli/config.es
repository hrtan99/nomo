module nomo.cli.config;

import std.collections.len;
import std.text.{parse_i32, from_i32};

public type Config = { steps: i32, budget: i32, once: bool, request: string, help: bool, error: string };

flow invalid(message: string) -> Config {
    return Config { steps = 0, budget = 0, once = false, request = "", help = false, error = message };
}

// Arguments are configuration; no file, environment or secret access is needed.
public flow load(args: Array<string>) -> Config {
    return load_for(args, "stub");
}

public flow load_for(args: Array<string>, provider: string) -> Config {
    if len(args) > 9 { return invalid("too many arguments"); }
    var steps: i32 = 3;
    var budget: i32 = 16;
    var once = false;
    var request = "";
    var seen_steps = false;
    var seen_budget = false;
    var seen_model = false;
    var index: usize = 0;
    while index < len(args) limit Iterations(10) {
        let flag = args[index];
        if flag == "--help" {
            if len(args) != 1 { return invalid("--help must be used alone"); }
            return Config { steps = steps, budget = budget, once = false, request = "", help = true, error = "" };
        }
        if flag == "--resume" || flag == "--persist" || flag == "--live" || flag == "--tools" || flag == "--cancel" {
            return invalid("unsupported mode: " + flag);
        }
        if flag != "--model" && flag != "--steps" && flag != "--budget" && flag != "--once" {
            return invalid("unknown option");
        }
        if index + 1 >= len(args) { return invalid("missing option value"); }
        let value = args[index + 1];
        if flag == "--model" {
            if seen_model { return invalid("duplicate --model"); }
            if value != provider { return invalid("unsupported model; only " + provider + " is available"); }
            seen_model = true;
        }
        if flag == "--steps" || flag == "--budget" {
            if flag == "--steps" && seen_steps { return invalid("duplicate --steps"); }
            if flag == "--budget" && seen_budget { return invalid("duplicate --budget"); }
            let parsed = match parse_i32(value) {
                Ok(number) => if number >= 1 && number <= 16 && from_i32(number) == value { number } else { 0 },
                Err(_) => 0,
            };
            if parsed < 1 || parsed > 16 {
                if flag == "--steps" { return invalid("steps must be canonical decimal in 1..16"); }
                return invalid("budget must be canonical decimal in 1..16");
            }
            if flag == "--steps" { steps = parsed; seen_steps = true; }
            else { budget = parsed; seen_budget = true; }
        }
        if flag == "--once" {
            if once { return invalid("duplicate --once"); }
            once = true;
            request = value;
        }
        index = index + 2;
    }
    if provider != "stub" && !seen_model { return invalid("model entry requires --model " + provider); }
    return Config { steps = steps, budget = budget, once = once, request = request, help = false, error = "" };
}
