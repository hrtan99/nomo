module nomo.agent.stub_loop_controller;

import std.text.{len, trim};
import nomo.core.text.input_error;
import nomo.model.stub.{next, dispatch};
import nomo.core.conversation.{State, capacity_error, charge, stop};
import nomo.agent.conversation_events.{Turn, emit, failure, reject};

public flow turn_controller(raw: string, maximum: i32, budget: i32, previous: State) -> Turn {
    if previous.stopped { return Turn { state = previous, status = 4 }; }
    let invalid = input_error(raw);
    if invalid != "" { return reject(previous, invalid); }
    let request = trim(raw);
    // Four events cover user/request/outcome/final-or-error for the sole fake tool.
    // Include a maximum prior-context answer, and keep the global stop reserve.
    var reserved = 4 * len(request) + 32;
    if reserved < len(request) + 1040 { reserved = len(request) + 1040; }
    let full = capacity_error(previous, 4, reserved);
    if full != "" { return failure(stop(previous), full, 4); }
    var state = emit(previous, "user", "input", "", request);
    var used: i32 = 0;
    var has_result = false;
    var result = "";
    while used < maximum limit Iterations(16) {
        if state.spent >= budget { return failure(state, "invocation step budget exhausted", 4); }
        used = used + 1;
        state = charge(state);
        let reply = next(request, previous.events, has_result, result);
        if reply.kind == "error" { return failure(state, reply.text, 3); }
        if reply.kind == "final" { return Turn { state = emit(state, "assistant", "final", "", reply.text), status = 0 }; }
        if reply.kind != "tool" { return failure(state, "invalid stub response", 3); }
        state = emit(state, "model", "request", reply.tool, reply.text);
        if used >= maximum { return failure(state, "step limit exhausted", 4); }
        if state.spent >= budget { return failure(state, "invocation step budget exhausted", 4); }
        used = used + 1;
        state = charge(state);
        let output = dispatch(reply.tool, reply.text);
        if !output.ok { return Turn { state = emit(state, "tool", "error", reply.tool, output.text), status = 3 }; }
        state = emit(state, "tool", "complete", reply.tool, output.text);
        result = output.text;
        has_result = true;
    }
    return failure(state, "step limit exhausted", 4);
}
