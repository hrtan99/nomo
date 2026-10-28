module nomo.ui.terminal_session;

import std.text.{len, to_string_i32};
import nomo.tools.edit_encoding.{object, json};

// Pure control state only: no admission, durable fact, approval or work authority.
public enum State { First, Second, Stopped(i32) }

public flow fresh(continuing: bool) -> State {
    return if continuing { State.Second } else { State.First };
}

public flow turn(state: State) -> i32 {
    return match state { State.First => 1, State.Second => 2, State.Stopped(last) => last };
}

public flow work_error(state: State) -> string {
    return match state {
        State.First => "",
        State.Second => "",
        State.Stopped(_) => "terminal session stopped; no retry or third turn",
    };
}

// Only the existing work-chain call's confirmed success may advance the session.
// Help/show/EOF never call this transition; --once always ends the invocation.
public flow after_turn(state: State, confirmed: bool, once: bool) -> Result<State, string> {
    return match state {
        State.First => Ok(if confirmed && !once { State.Second } else { State.Stopped(1) }),
        State.Second => Ok(State.Stopped(2)),
        State.Stopped(_) => Err("terminal session stopped; no retry or third turn"),
    };
}

// Configuration display only; this neither reads a durable balance nor grants work.
public flow state_line(state: State, root_id: string, child_id: string, workspace: string, path: string, cap: string, once: bool) -> Result<string, string> {
    let selected_turn = turn(state);
    if selected_turn != 1 && selected_turn != 2 { return Err("invalid terminal display turn"); }
    let phase = match state { State.First => "first", State.Second => "second", State.Stopped(_) => "stopped" };
    let remaining = match state { State.First => if once { 1 } else { 2 }, State.Second => 1, State.Stopped(_) => 0 };
    let current = if selected_turn == 1 { root_id } else { child_id };
    let value = match object(["phase", "root_id", "current_id", "turn", "configured_turns_in_process", "workspace", "path", "configured_cap", "once", "scope"],
        [phase, root_id, current, to_string_i32(selected_turn), to_string_i32(remaining), workspace, path,
        if cap == "" { "work-chain defaults" } else { cap }, if once { "true" } else { "false" },
        "configuration only; not a durable balance, File observation or permission"]) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    return Ok("SESSION " + value);
}

// Escaping is separate from request validation and supplies no execution authority.
public flow request_line(request: string) -> Result<string, string> {
    if len(request) > 128 { return Err("terminal request display exceeds 128 characters"); }
    return match json([request]) { Ok(value) => Ok("USER " + value), Err(error) => Err(error) };
}
