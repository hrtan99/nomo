module nomo.adapters.cli.arguments.session_cli_args;

import nomo.domain.context.large_context.request_bytes;
import std.text.{char_count as len, parse_i32, from_i32};
import nomo.domain.sessions.store_record.valid_id;
import nomo.domain.text.text.{printable, input_error};

public type Options = { verb: string, session_id: string, save_id: string, binding: string,
    input: string, maximum: i32, budget: i32 };

flow parse_limit(value: string) -> i32 {
    return match parse_i32(value) {
        Ok(number) => if number >= 1 && number <= 16 && from_i32(number) == value { number } else { 0 },
        Err(_) => 0,
    };
}

// Parse the entire command before selecting any conversation or storage path.
public flow parse(args: Array<string>) -> Result<Options, string> {
    if args.len() == 0 || args.len() > 13 { return Err("expected bounded save/show arguments"); }
    let verb = args[0];
    if verb == "--help" && args.len() == 1 {
        let help = Options { verb = "help", session_id = "", save_id = "", binding = "", input = "", maximum = 3, budget = 16 };
        return Ok(help);
    }
    if verb != "save" && verb != "show" { return Err("expected save or show"); }
    var session_id = "";
    var save_id = "";
    var binding = "";
    var input = "";
    var maximum: i32 = 3;
    var budget: i32 = 16;
    var seen: Array<string> = [];
    var supplied_input = false;
    var index: usize = 1;
    @limits([Iterations(6)]) while index < args.len() {
        let flag = args[index];
        if flag != "--session" && flag != "--save" && flag != "--binding" &&
            flag != "--input" && flag != "--steps" && flag != "--budget" { return Err("unknown option"); }
        @limits([Iterations(6)]) for previous in seen {
            if previous == flag { return Err("duplicate option"); }
        }
        seen = seen.push(flag);
        if index + 1 >= args.len() { return Err("missing option value"); }
        let value = args[index + 1];
        if flag == "--session" { session_id = value; }
        else if flag == "--save" { save_id = value; }
        else if flag == "--binding" { binding = value; }
        else if flag == "--input" { input = value; supplied_input = true; }
        else {
            let parsed = parse_limit(value);
            if parsed == 0 { return Err("settings must be canonical decimal in 1..16"); }
            if flag == "--steps" { maximum = parsed; } else { budget = parsed; }
        }
        index = index + 2;
    }
    if !valid_id(session_id) || !valid_id(save_id) || !valid_id(binding) { return Err("explicit valid session, save and binding required"); }
    if verb == "save" {
        if !supplied_input { return Err("save requires input"); }
        if len(input) > request_bytes() || !printable(input) { return Err("input must be bounded printable ASCII"); }
        let invalid = input_error(input);
        if invalid != "" { return Err(invalid); }
    } else if supplied_input { return Err("show forbids input"); }
    let options = Options { verb, session_id, save_id, binding,
        input, maximum, budget };
    return Ok(options);
}
