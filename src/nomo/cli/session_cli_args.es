module nomo.cli.session_cli_args;

import std.collections.len as count;
import nomo.session.store_record.valid_id;
import nomo.core.text.{printable, input_error};

public type Options = { verb: string, session_id: string, save_id: string, binding: string,
    input: string, maximum: i32, budget: i32 };

flow parse_limit(value: string) -> i32 {
    return match value {
        "1" => 1, "2" => 2, "3" => 3, "4" => 4, "5" => 5, "6" => 6, "7" => 7, "8" => 8,
        "9" => 9, "10" => 10, "11" => 11, "12" => 12, "13" => 13, "14" => 14, "15" => 15, "16" => 16,
        _ => 0,
    };
}

// Parse the entire command before selecting any conversation or storage path.
public flow parse(args: Array<string>) -> Result<Options, string> {
    if count(args) == 0 || count(args) > 13 { return Err("expected bounded save/show arguments"); }
    let verb = args[0];
    if verb == "--help" && count(args) == 1 {
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
    while index < count(args) limit Iterations(6) {
        let flag = args[index];
        if flag != "--session" && flag != "--save" && flag != "--binding" &&
            flag != "--input" && flag != "--steps" && flag != "--budget" { return Err("unknown option"); }
        for previous in seen limit Iterations(6) {
            if previous == flag { return Err("duplicate option"); }
        }
        seen = seen.push(flag);
        if index + 1 >= count(args) { return Err("missing option value"); }
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
        if std.text.len(input) > 1024 || !printable(input) { return Err("input must be bounded printable ASCII"); }
        let invalid = input_error(input);
        if invalid != "" { return Err(invalid); }
    } else if supplied_input { return Err("show forbids input"); }
    let options = Options { verb = verb, session_id = session_id, save_id = save_id, binding = binding,
        input = input, maximum = maximum, budget = budget };
    return Ok(options);
}
