module nomo.application.harness.text;

import nomo.application.harness.ports.{
    Context,
    ConversationOutput,
    ModelText,
    TextDelegationOutput,
    TextDelegationStages
};
import nomo.core.conversation.{Event, State};
import nomo.domain.conversation.{TextTurn, add, capacity_error, charge, stop};
import nomo.domain.harness.delegation.{
    ChildResult,
    ChildTask,
    child_error as delegation_child_error,
    dispatch,
    fixed_refusal,
    next,
    safe_text
};
import nomo.domain.harness.read.{
    ChildTask as read_ChildTask,
    TextContext,
    bounded,
    charge_boundary,
    charge_call,
    text_context_error,
    text_decode_plan,
    text_fresh
};
import nomo.domain.limits.{context_bytes, message_bytes};
import nomo.domain.text.{input_error, text_printable};
import std.text.{char_count, trim};

flow refused(task: ChildTask, used: i32, text: string) -> ChildResult {
    let safe = if fixed_refusal(text) {
        text
    } else {
        "invalid stub response"
    };
    return ChildResult {
        id = task.id,
        status = "refused",
        text = safe,
        used
    };
}

// A synchronous Etas agent runner: decisions and the one pure fake tool are real
// calls, not precomputed answers. The supplied selected context stays unchanged.
public flow harness_child_run(task: ChildTask) -> ChildResult {
    let invalid = delegation_child_error(task);
    if invalid != "" {
        return ChildResult {
            id = task.id,
            status = "refused",
            text = invalid,
            used = 0
        };
    }
    var history: Array<Event> = [];
    @limits([Iterations(4)]) for text in task.context {
        history = history.push(Event {
            role = "user",
            kind = "input",
            name = "",
            text
        });
    }
    let request = trim(task.task);
    var used: i32 = 0;
    var has_result = false;
    var result = "";
    @limits([Iterations(3)]) while used < task.allowance {
        used = used + 1;
        let reply = next(request, history, has_result, result);
        if reply.kind == "error" {
            return refused(task, used, reply.text);
        }
        if reply.kind == "final" {
            if !safe_text(reply.text, 1152) {
                return refused(task, used, "invalid child output");
            }
            return ChildResult {
                id = task.id,
                status = "completed",
                text = reply.text,
                used
            };
        }
        if reply.kind != "tool" || has_result {
            return refused(task, used, "invalid stub response");
        }
        // Refuse an unpermitted selection before dispatch and its second charge.
        if reply.tool != "echo" {
            return refused(task, used, "unknown tool");
        }
        if used >= task.allowance {
            return refused(task, used, "child step limit exhausted");
        }
        used = used + 1;
        let outcome = dispatch(reply.tool, reply.text);
        if !outcome.ok {
            return refused(task, used, outcome.text);
        }
        result = outcome.text;
        has_result = true;
    }
    return refused(task, used, "child step limit exhausted");
}

// One invocation owns all five steps and all three conservative call allowances.
// Host .run aborts are deliberately not represented as caught/settled outcomes.
public flow text_delegation_run(request: string) -> i32 {
    var state = text_fresh();
    if !bounded(request, message_bytes()) {
        return perform TextDelegationOutput.refused(
            state,
            "request requires 1..1048576 printable ASCII characters"
        );
    }
    let plan_context = TextContext {
        phase = "plan",
        request,
        task = "",
        result = ""
    };
    let plan_error = text_context_error(plan_context);
    if plan_error != "" {
        return perform TextDelegationOutput.refused(state, plan_error);
    }
    state = match charge_call(state) {
        Ok(value) => value,
        Err(error) => {
            return perform TextDelegationOutput.refused(state, error);
        }
    };
    perform TextDelegationOutput.precharged("plan", state);
    let raw_plan = perform TextDelegationStages.main(plan_context);
    let task = match text_decode_plan(raw_plan) {
        Ok(value) => value,
        Err(error) => {
            return perform TextDelegationOutput.refused(state, error);
        }
    };
    state = match charge_boundary(state) {
        Ok(value) => value,
        Err(error) => {
            return perform TextDelegationOutput.refused(state, error);
        }
    };
    let child = read_ChildTask {
        id = "child-1",
        depth = 1,
        task,
        request
    };
    perform TextDelegationOutput.line("EVENT main -> " + child.id + " request " + child.id + ": " + child.task);
    let child_context = TextContext {
        phase = "child",
        request = child.request,
        task = child.task,
        result = ""
    };
    let child_error = text_context_error(child_context);
    if child_error != "" {
        return perform TextDelegationOutput.refused(state, child_error);
    }
    state = match charge_call(state) {
        Ok(value) => value,
        Err(error) => {
            return perform TextDelegationOutput.refused(state, error);
        }
    };
    perform TextDelegationOutput.precharged("child", state);
    let result = perform TextDelegationStages.child(child_context);
    if !bounded(result, message_bytes()) {
        return perform TextDelegationOutput.refused(state, "invalid bounded child result");
    }
    perform TextDelegationOutput.line("EVENT " + child.id + " -> main result " + child.id + ": " + result);
    state = match charge_boundary(state) {
        Ok(value) => value,
        Err(error) => {
            return perform TextDelegationOutput.refused(state, error);
        }
    };
    perform TextDelegationOutput.line("EVENT main -> main consume " + child.id + ": " + result);
    let aggregate_context = TextContext {
        phase = "aggregate",
        request,
        task = child.task,
        result
    };
    let aggregate_error = text_context_error(aggregate_context);
    if aggregate_error != "" {
        return perform TextDelegationOutput.refused(state, aggregate_error);
    }
    state = match charge_call(state) {
        Ok(value) => value,
        Err(error) => {
            return perform TextDelegationOutput.refused(state, error);
        }
    };
    perform TextDelegationOutput.precharged("aggregate", state);
    let answer = perform TextDelegationStages.main(aggregate_context);
    if !bounded(answer, message_bytes()) {
        return perform TextDelegationOutput.refused(state, "invalid bounded final answer");
    }
    perform TextDelegationOutput.line("FINAL " + answer);
    perform TextDelegationOutput.settled(state);
    return 0;
}

public flow emit(state: State, role: string, kind: string, name: string, text: string) -> State {
    let event = Event {
        role,
        kind,
        name,
        text
    };
    let updated = add(state, event);
    perform ConversationOutput.publish(event);
    return updated;
}

public flow failure(state: State, message: string, status: i32) -> TextTurn {
    return TextTurn {
        state = emit(state, "error", "error", "", message),
        status
    };
}

public flow reject(state: State, message: string) -> TextTurn {
    let full = capacity_error(state, 1, 64);
    if full != "" {
        return failure(stop(state), full, 4);
    }
    return failure(state, message, 2);
}

public flow model_turn_controller(raw: string, maximum: i32, budget: i32, previous: State) -> TextTurn {
    if previous.stopped {
        return TextTurn {
            state = previous,
            status = 4
        };
    }
    let invalid = input_error(raw);
    if invalid != "" {
        return reject(previous, invalid);
    }
    let request = trim(raw);
    // User + model attempt + final/error; retain the separate global stop reserve.
    let full = capacity_error(previous, 3, char_count(request) + message_bytes() + 4);
    if full != "" {
        return failure(stop(previous), full, 4);
    }
    // ASCII JSON escaping is at most 2x, plus bounded event metadata/envelope.
    if 2 * (previous.characters + char_count(request)) + 128 * previous.events.len() + 256 > context_bytes() {
        return reject(previous, "model context capacity exhausted");
    }
    var state = emit(previous, "user", "input", "", request);
    if maximum < 1 {
        return failure(state, "step limit exhausted", 4);
    }
    if state.spent >= budget {
        return failure(state, "invocation step budget exhausted", 4);
    }
    // Four attempts reserve at most 8192 total input+output tokens. No refunds.
    if state.spent >= 4 {
        return failure(state, "model token reservation exhausted", 4);
    }
    state = charge(state);
    state = emit(state, "model", "text", "qwen", "");
    let response = perform ModelText.infer(Context {
        history = previous.events,
        request
    });
    if char_count(response) > message_bytes() {
        return failure(state, "model output exceeds 1048576 characters", 3);
    }
    let text = trim(response);
    if text == "" {
        return failure(state, "model output is empty", 3);
    }
    if !text_printable(text) {
        return failure(state, "model output must be printable ASCII single-line text", 3);
    }
    return TextTurn {
        state = emit(state, "assistant", "final", "", text),
        status = 0
    };
}

public flow turn_controller(raw: string, maximum: i32, budget: i32, previous: State) -> TextTurn {
    if previous.stopped {
        return TextTurn {
            state = previous,
            status = 4
        };
    }
    let invalid = input_error(raw);
    if invalid != "" {
        return reject(previous, invalid);
    }
    let request = trim(raw);
    // Four events cover user/request/outcome/final-or-error for the sole fake tool.
    // Include a maximum prior-context answer, and keep the global stop reserve.
    var reserved = 4 * char_count(request) + 32;
    if reserved < char_count(request) + 1040 {
        reserved = char_count(request) + 1040;
    }
    let full = capacity_error(previous, 4, reserved);
    if full != "" {
        return failure(stop(previous), full, 4);
    }
    var state = emit(previous, "user", "input", "", request);
    var used: i32 = 0;
    var has_result = false;
    var result = "";
    @limits([Iterations(16)]) while used < maximum {
        if state.spent >= budget {
            return failure(state, "invocation step budget exhausted", 4);
        }
        used = used + 1;
        state = charge(state);
        let reply = next(request, previous.events, has_result, result);
        if reply.kind == "error" {
            return failure(state, reply.text, 3);
        }
        if reply.kind == "final" {
            return TextTurn {
                state = emit(state, "assistant", "final", "", reply.text),
                status = 0
            };
        }
        if reply.kind != "tool" {
            return failure(state, "invalid stub response", 3);
        }
        state = emit(state, "model", "request", reply.tool, reply.text);
        if used >= maximum {
            return failure(state, "step limit exhausted", 4);
        }
        if state.spent >= budget {
            return failure(state, "invocation step budget exhausted", 4);
        }
        used = used + 1;
        state = charge(state);
        let output = dispatch(reply.tool, reply.text);
        if !output.ok {
            return TextTurn {
                state = emit(state, "tool", "error", reply.tool, output.text),
                status = 3
            };
        }
        state = emit(state, "tool", "complete", reply.tool, output.text);
        result = output.text;
        has_result = true;
    }
    return failure(state, "step limit exhausted", 4);
}
