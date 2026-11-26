module nomo.application.harness.loops.provider_controller;

import nomo.domain.context.large_context.{message_bytes, context_bytes};
import std.text.{char_count as len, trim};
import std.collections.len as event_count;
import nomo.core.conversation.State;
import nomo.domain.conversation.state.{capacity_error, charge, stop};
import nomo.domain.harness.conversation_events.Turn;
import nomo.application.harness.loops.conversation_events.{emit, failure, reject};
import nomo.domain.text.text.{input_error, printable};
import nomo.domain.harness.text_stage.Context;
import nomo.application.harness.effects.model_text_stage.ModelText;

public flow model_turn_controller(raw: string, maximum: i32, budget: i32, previous: State) -> Turn {
    if previous.stopped { return Turn { state = previous, status = 4 }; }
    let invalid = input_error(raw);
    if invalid != "" { return reject(previous, invalid); }
    let request = trim(raw);
    // User + model attempt + final/error; retain the separate global stop reserve.
    let full = capacity_error(previous, 3, len(request) + message_bytes() + 4);
    if full != "" { return failure(stop(previous), full, 4); }
    // ASCII JSON escaping is at most 2x, plus bounded event metadata/envelope.
    if 2 * (previous.characters + len(request)) + 128 * event_count(previous.events) + 256 > context_bytes() {
        return reject(previous, "model context capacity exhausted");
    }
    var state = emit(previous, "user", "input", "", request);
    if maximum < 1 { return failure(state, "step limit exhausted", 4); }
    if state.spent >= budget { return failure(state, "invocation step budget exhausted", 4); }
    // Four attempts reserve at most 8192 total input+output tokens. No refunds.
    if state.spent >= 4 { return failure(state, "model token reservation exhausted", 4); }
    state = charge(state);
    state = emit(state, "model", "text", "qwen", "");
    let response = perform ModelText.infer(Context { history = previous.events, request });
    if len(response) > message_bytes() { return failure(state, "model output exceeds 1048576 characters", 3); }
    let text = trim(response);
    if text == "" { return failure(state, "model output is empty", 3); }
    if !printable(text) { return failure(state, "model output must be printable ASCII single-line text", 3); }
    return Turn { state = emit(state, "assistant", "final", "", text), status = 0 };
}
