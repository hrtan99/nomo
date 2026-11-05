module app.contract_probe;

import std.io.println;
import std.text.{char_count as len, split};
import nomo.core.text.printable;
import nomo.cli.terminal_args.{Config, LineCommand, parse, parse_once, line, work_request, show_selector};
import nomo.tools.edit_contract.Selector;
import nomo.session.work_chain.Caps;
import nomo.session.work_chain_usecase.{WorkRequest, ContinueRequest, TurnRequest};
import nomo.ui.terminal_session.{State, fresh, turn, work_error, after_turn, state_line, request_line};

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow parsed(args: Array<string>, expected: Config) -> bool {
    return match parse(args) { Ok(value) => value == expected, Err(_) => false };
}
flow refused(args: Array<string>) -> bool { return match parse(args) { Ok(_) => false, Err(_) => true }; }
flow once_parsed(args: Array<string>, expected: Config) -> bool {
    return match parse_once(args) { Ok(value) => value == expected, Err(_) => false };
}
flow once_refused(args: Array<string>) -> bool { return match parse_once(args) { Ok(_) => false, Err(_) => true }; }
flow once_required(args: Array<string>) -> bool {
    let valid = match parse(args) { Ok(_) => true, Err(_) => false };
    return valid && match parse_once(args) { Ok(_) => false, Err(error) => error == "non-TTY terminal mode requires explicit --once REQUEST" };
}
flow once_work(args: Array<string>, selected_turn: i32, request: string, expected: TurnRequest) -> bool {
    let config = match parse_once(args) { Ok(value) => value, Err(_) => { return false; } };
    return match work_request(config, selected_turn, request) { Ok(value) => value == expected, Err(_) => false };
}
flow once_work_refused(args: Array<string>, selected_turn: i32, request: string) -> bool {
    let config = match parse_once(args) { Ok(value) => value, Err(_) => { return false; } };
    return match work_request(config, selected_turn, request) { Ok(_) => false, Err(_) => true };
}
flow command(raw: string, expected: string, text: string) -> bool {
    return match line(raw) {
        Err(_) => expected == "invalid",
        Ok(value) => match value {
            LineCommand.Request(actual) => expected == "request" && actual == text,
            LineCommand.Help => expected == "help" && text == "",
            LineCommand.Show => expected == "show" && text == "",
            LineCommand.Exit => expected == "exit" && text == "",
            LineCommand.Eof => expected == "eof" && text == "",
        },
    };
}
flow non_work(raw: string) -> bool {
    return match line(raw) {
        Err(_) => false,
        Ok(value) => match value {
            LineCommand.Request(_) => false,
            LineCommand.Help => true,
            LineCommand.Show => true,
            LineCommand.Exit => true,
            LineCommand.Eof => true,
        },
    };
}
flow work(args: Array<string>, selected_turn: i32, request: string, expected: TurnRequest) -> bool {
    let config = match parse(args) { Ok(value) => value, Err(_) => { return false; } };
    return match work_request(config, selected_turn, request) { Ok(value) => value == expected, Err(_) => false };
}
flow work_refused(args: Array<string>, selected_turn: i32, request: string) -> bool {
    let config = match parse(args) { Ok(value) => value, Err(_) => { return false; } };
    return match work_request(config, selected_turn, request) { Ok(_) => false, Err(_) => true };
}
flow selected(args: Array<string>, selected_turn: i32, expected: Selector) -> bool {
    let config = match parse(args) { Ok(value) => value, Err(_) => { return false; } };
    return match show_selector(config, selected_turn) { Ok(value) => value == expected, Err(_) => false };
}
flow selection_refused(args: Array<string>, selected_turn: i32) -> bool {
    let config = match parse(args) { Ok(value) => value, Err(_) => { return false; } };
    return match show_selector(config, selected_turn) { Ok(_) => false, Err(_) => true };
}
flow phase(value: State, expected_turn: i32, stopped: bool) -> bool {
    return turn(value) == expected_turn && (work_error(value) != "") == stopped;
}
flow transition(continuing: bool, confirmed: bool, once: bool, expected_turn: i32, stopped: bool) -> bool {
    return match after_turn(fresh(continuing), confirmed, once) { Ok(value) => phase(value, expected_turn, stopped), Err(_) => false };
}
flow sequence() -> bool {
    let first = fresh(false);
    let second = match after_turn(first, true, false) { Ok(value) => value, Err(_) => { return false; } };
    let stopped = match after_turn(second, true, false) { Ok(value) => value, Err(_) => { return false; } };
    return phase(first, 1, false) && phase(second, 2, false) && phase(stopped, 2, true) &&
        match after_turn(stopped, true, false) { Ok(_) => false, Err(_) => true };
}
flow stopped_refused(last: i32) -> bool {
    let value = State.Stopped(last);
    return work_error(value) != "" && match after_turn(value, true, false) { Ok(_) => false, Err(_) => true };
}
flow rendered(state: State, root: string, child: string, workspace: string, path: string, cap: string, once: bool, expected: string) -> bool {
    return match state_line(state, root, child, workspace, path, cap, once) { Ok(value) => value == expected && printable(value) && len(value) <= 4096, Err(_) => false };
}
flow render_refused(last: i32) -> bool {
    return match state_line(State.Stopped(last), "root-op", "child-op", "owned", "target.txt", "", false) { Ok(_) => false, Err(_) => true };
}
flow rendered_request(raw: string, expected: string) -> bool {
    return match request_line(raw) { Ok(value) => value == expected && printable(value), Err(_) => false };
}
flow request_render_refused(raw: string) -> bool { return match request_line(raw) { Ok(_) => false, Err(_) => true }; }

public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !item.passed { println("FAIL " + item.label); abort("terminal pure contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
