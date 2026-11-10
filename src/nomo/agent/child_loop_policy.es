module nomo.agent.child_loop_policy;

import nomo.core.large_context.{message_bytes, context_bytes};

import nomo.model.model_tool_contract.{Session, Limits, Context, budget_error, charge_action, context_error, candidate_error, allowed_error, question_error};


import nomo.core.conversation.charge;
import nomo.core.read_text.bounded;
import nomo.core.large_context.{scan_bytes, display_bytes, outcome_bytes};

public type Shape = { calls: usize, tools: usize, context_bytes: usize, input_characters: usize, result_characters: usize, slots: usize, characters: usize, tool_characters: usize, whole_scope: bool, partial_search: bool, named_final: bool, legacy_text: bool };
public spec ChildLoopPolicy {
    flow shape(self) -> Shape ![];
    flow allowed_error(self, allowed: Array<string>) -> string ![Error<IndexError>];
    flow request_error(self, request: string) -> string ![Error<IndexError>];
    flow validate_context(self, context: Context) -> string ![Error<IndexError>];
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> ![Error<IndexError>];
    flow reserve_tool(self, state: Session) -> Result<Session, string> ![Error<IndexError>];
}
public type BoundedChild = { limits: Limits, work: bool, chat: bool };
public type ExpandedChild = { wide: bool, high_input: bool };
public type MultiChild = { resilient: bool, reasoning: bool };
public type LegacyChild = { limits: Limits };

flow single_shape(input_characters: usize) -> Shape { return Shape { calls = 2, tools = 1, context_bytes = context_bytes(), input_characters = input_characters, result_characters = display_bytes(), slots = 2, characters = message_bytes() + 64, tool_characters = outcome_bytes() + 20, whole_scope = false, partial_search = false, named_final = true, legacy_text = false }; }
flow request_error(request: string, work: bool) -> string {
    if work { return if bounded(request, message_bytes()) { "" } else { "work delegation requires 1..1048576 safe UTF-8 bytes" }; }
    return if bounded(request, message_bytes()) { "" } else { "question requires 1..1048576 safe UTF-8 bytes, not only spaces" };
}
flow charged(state: Session, tokens: usize, tool_scan: usize) -> Session {
    return Session { history = charge(state.history), calls = state.calls + if tool_scan == 0 { 1 } else { 0 }, tokens = state.tokens + tokens, tools = state.tools + if tool_scan == 0 { 0 } else { 1 }, scan = state.scan + tool_scan };
}
impl BoundedChild ~ ChildLoopPolicy {
    flow allowed_error(self, allowed: Array<string>) -> string { return candidate_error(allowed); }
    flow shape(self) -> Shape ![] { return single_shape(message_bytes()); }
    flow request_error(self, request: string) -> string { return request_error(request, self.work); }
    flow validate_context(self, context: Context) -> string { return if self.chat { "" } else { context_error(context) }; }
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> {
        return reserve(state, self.limits, false);
    }
    flow reserve_tool(self, state: Session) -> Result<Session, string> {
        return reserve(state, self.limits, true);
    }
}
impl ExpandedChild ~ ChildLoopPolicy {
    flow allowed_error(self, allowed: Array<string>) -> string { return candidate_error(allowed); }
    flow shape(self) -> Shape ![] { return single_shape(message_bytes()); }
    flow request_error(self, request: string) -> string { return request_error(request, true); }
    flow validate_context(self, context: Context) -> string { return context_error(context); }
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> {
        let unit: usize = if self.high_input { 131072 } else { 4096 };
        if state.history.spent >= 3 || state.calls >= 2 || state.tokens != state.calls * unit || state.tools > 1 || state.scan > scan_bytes() { return Err("expanded work model reservation exhausted"); }
        return Ok(charged(state, if self.high_input || (final_only && self.wide) { 131072 } else { 4096 }, 0));
    }
    flow reserve_tool(self, state: Session) -> Result<Session, string> {
        if state.tools != 0 || state.scan != 0 || state.history.spent >= 3 { return Err("expanded work tool reservation exhausted"); }
        return Ok(charged(state, 0, scan_bytes()));
    }
}
impl MultiChild ~ ChildLoopPolicy {
    flow allowed_error(self, allowed: Array<string>) -> string { return candidate_error(allowed); }
    flow shape(self) -> Shape ![] { return Shape { calls = 4, tools = 3, context_bytes = context_bytes(), input_characters = message_bytes(), result_characters = display_bytes(), slots = 4, characters = outcome_bytes() + message_bytes() + 64, tool_characters = 0, whole_scope = true, partial_search = true, named_final = false, legacy_text = false }; }
    flow request_error(self, request: string) -> string { return if bounded(request, message_bytes()) { "" } else { "invalid selected child context" }; }
    flow validate_context(self, context: Context) -> string ![] { return ""; }
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> ![] {
        return Ok(charged(state, if self.resilient && (final_only || self.reasoning) { 131072 } else { if self.reasoning { 16384 } else { 4096 } }, 0));
    }
    flow reserve_tool(self, state: Session) -> Result<Session, string> ![] { return Ok(charged(state, 0, 4194560)); }
}

impl LegacyChild ~ ChildLoopPolicy {
    flow shape(self) -> Shape ![] { return Shape { calls = 2, tools = 1, context_bytes = context_bytes(), input_characters = message_bytes(), result_characters = 256, slots = 2, characters = message_bytes() + 64, tool_characters = outcome_bytes() + 20, whole_scope = false, partial_search = false, named_final = true, legacy_text = true }; }
    flow allowed_error(self, allowed: Array<string>) -> string { return allowed_error(allowed); }
    flow request_error(self, request: string) -> string { return question_error(request); }
    flow validate_context(self, context: Context) -> string { return context_error(context); }
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> {
        return reserve(state, self.limits, false);
    }
    flow reserve_tool(self, state: Session) -> Result<Session, string> {
        return reserve(state, self.limits, true);
    }
}

flow reserve(state: Session, limits: Limits, tool: bool) -> Result<Session, string> {
    let error = budget_error(state, limits, tool); if error != "" { return Err(error); }
    return Ok(charge_action(state, tool, limits));
}
