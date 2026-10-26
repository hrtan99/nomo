module nomo.cli.continuation_args;

import std.collections.len as count;
import nomo.cli.session_cli_args.{Options, parse};
import nomo.session.store_record.valid_id;

public type ContinueOptions = { turn: Options, generation: i32, next_save: string };

// Consume pairs atomically, including inputs that look like flags.
public flow parse_continue(args: Array<string>) -> Result<ContinueOptions, string> {
    if count(args) < 1 || count(args) > 17 || args[0] != "continue" { return Err("expected bounded continue arguments"); }
    var normalized: Array<string> = ["save"];
    var next_save = "";
    var generation: i32 = -1;
    var seen_generation = false;
    var seen_next = false;
    var index: usize = 1;
    while index < count(args) limit Iterations(8) {
        if index + 1 >= count(args) { return Err("missing option value"); }
        let flag = args[index];
        let value = args[index + 1];
        if flag == "--generation" {
            if seen_generation { return Err("duplicate option"); }
            seen_generation = true;
            generation = match value { "0" => 0, "1" => 1, _ => -1 };
            if generation < 0 { return Err("expected canonical generation 0 or 1"); }
        } else if flag == "--next-save" {
            if seen_next { return Err("duplicate option"); }
            seen_next = true;
            next_save = value;
        } else { normalized = normalized.push(flag).push(value); }
        index = index + 2;
    }
    let options = match parse(normalized) { Ok(value) => value, Err(error) => { return Err(error); } };
    if !seen_generation || !seen_next || !valid_id(next_save) || next_save == options.save_id {
        return Err("explicit generation and distinct valid next save required");
    }
    return Ok(ContinueOptions { turn = options, generation = generation, next_save = next_save });
}
