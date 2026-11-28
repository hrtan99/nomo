module app.contract_probe;

import std.io.println;
import std.text.split;
import nomo.domain.sessions.checkpoints.Identity;
import nomo.adapters.cli.checkpoint_input.Request;
import nomo.adapters.cli.checkpoint_input.session_lifecycle_args_parse as parse;
import nomo.adapters.cli.checkpoint_input.help_lines;
import nomo.adapters.cli.checkpoint_input.topic_lines;

type Check = { label: string, action: string, args: Array<string>, accepted: bool, expected: Request, error: string };
flow slash() -> string { return std.text.from_char('\\'); }
flow expected_help() -> Array<string> { return __HELP__; }
flow checks() -> Array<Check> { return __CHECKS__; }
flow evaluate(item: Check) -> bool {
    if item.action == "@help_lines" { return (help_lines()).len() == 14 && help_lines() == expected_help(); }
    if item.action == "@topic_lines" { return topic_lines(item.expected.request) == item.args; }
    return match parse(item.action, item.args) {
        Ok(value) => item.accepted && value == item.expected,
        Err(error) => !item.accepted && error == item.error
    };
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(128) { if !evaluate(item) { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(128) {
        if !evaluate(item) { println("FAIL " + item.label); abort("pure session lifecycle contract check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
