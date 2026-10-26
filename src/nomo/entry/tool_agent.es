module nomo.entry.tool_agent;

import std.text.{split, len};
import std.collections.len as count;
import std.io.println;
import nomo.cli.config.load_for;
import nomo.core.conversation.{State, fresh, capacity_error, charge, stop};
import nomo.agent.loop.{Turn, emit, failure, reject};
import nomo.core.text.{input_error, printable};
import nomo.tools.workspace.{Outcome, outcome, read_file, list_directory, search_files, display};

public type Request = { operation: string, files: Array<string>, literal: string };
public type Session = { history: State, reserved: usize };
public type ToolTurn = { state: Session, status: i32 };

public flow fresh_tools() -> Session { return Session { history = fresh(), reserved = 0 }; }

// Reserve the worst-case two-file scan before any attempted turn; no refunds.
// This separate byte ledger survives alongside the existing conversation budget.
public flow tool_turn(raw: string, maximum: i32, budget: i32, previous: Session) -> ToolTurn {
    if previous.history.stopped { return ToolTurn { state = previous, status = 4 }; }
    if previous.reserved > 4096 {
        let failed = failure(stop(previous.history), "invocation scan reservation exhausted", 4);
        return ToolTurn { state = Session { history = failed.state, reserved = previous.reserved }, status = 4 };
    }
    let reservation = previous.reserved + 4096;
    let result = perform_turn(raw, maximum, budget, previous.history);
    return ToolTurn { state = Session { history = result.state, reserved = reservation }, status = result.status };
}

flow completed_reply(state: State) -> string {
    let event = state.events[count(state.events) - 1];
    if event.role != "tool" || event.kind != "complete" { abort("scripted Provider requires a completed result"); }
    return "read-only result: " + event.text;
}

// Explicit scripted Provider protocol only. TextModel output never enters here.
public flow dispatch(request: Request) -> Outcome {
    if request.operation == "read" && count(request.files) == 1 && request.literal == "" { return display(read_file(request.files[0])); }
    if request.operation == "list" && count(request.files) == 1 && request.literal == "" { return display(list_directory(request.files[0])); }
    if request.operation == "search" { return display(search_files(request.files, request.literal)); }
    return outcome("refused", "unsupported operation or arguments", 0);
}

flow perform_turn(raw: string, maximum: i32, budget: i32, previous: State) -> Turn {
    if previous.stopped { return Turn { state = previous, status = 4 }; }
    let invalid = input_error(raw);
    if invalid != "" { return reject(previous, invalid); }
    // The shared validator trims for stub/model input; this protocol uses raw.
    if !printable(raw) { return reject(previous, "expected printable ASCII single-line input"); }
    let parts = split(raw, ":");
    if count(parts) < 2 || count(parts) > 3 { return reject(previous, "expected read:FILE, list:DIR or search:FILE[,FILE]:LITERAL"); }
    let operation = parts[0];
    let files = split(parts[1], ",");
    var literal = "";
    if count(parts) == 3 { literal = parts[2]; }
    if (operation != "read" && operation != "list" && operation != "search") || (operation != "search" && count(parts) != 2) || (operation == "search" && count(parts) != 3) {
        return reject(previous, "unsupported operation or arguments");
    }
    let full = capacity_error(previous, 4, 2 * len(raw) + 2304);
    if full != "" { return failure(stop(previous), full, 4); }
    var state = emit(previous, "user", "input", "", raw);
    if maximum < 1 || state.spent >= budget { return failure(state, "invocation step budget exhausted", 4); }
    state = charge(state);
    state = emit(state, "model", "request", operation, raw);
    if maximum < 2 || state.spent >= budget { return failure(state, "invocation step budget exhausted before tool", 4); }
    state = charge(state);
    let result = dispatch(Request { operation = operation, files = files, literal = literal });
    let data = result.status + ": " + result.text;
    // Refusals are recorded, but never represented as completed successful tools.
    if result.status != "complete" && result.status != "truncated" {
        return Turn { state = emit(state, "tool", "error", operation, data), status = 3 };
    }
    state = emit(state, "tool", "complete", operation, data);
    if maximum < 3 || state.spent >= budget { return failure(state, "invocation step budget exhausted before final", 4); }
    state = charge(state);
    // Deterministic Provider consumes the completed result as data, never parses it.
    return Turn { state = emit(state, "assistant", "final", "", completed_reply(state)), status = 0 };
}

public flow run_tools(args: Array<string>) -> i32 {
    let config = load_for(args, "scripted");
    if config.error != "" { println("error: " + config.error); abort("read-only configuration rejected"); }
    if config.help {
        println("Read-only synthetic-workspace entry: --model scripted --once read:FILE|list:DIR|search:FILE[,FILE]:LITERAL");
        println("Requires an explicit scoped read-only profile; no default root, recursion, write, shell, live model or retry.");
        println("Accepted API limits: whole-file reads and opaque directory entries; admitted small immutable fixtures only.");
        return 0;
    }
    if !config.once { println("error: read-only entry requires --once"); abort("read-only configuration rejected"); }
    let result = tool_turn(config.request, config.steps, config.budget, fresh_tools());
    if result.status != 0 { abort("read-only turn failed; see outcome"); }
    return 0;
}
