module nomo.harness.chat_budget_policy;

import nomo.harness.harness_tool_contract.{Ledger, bump, settle};
import nomo.model.model_tool_contract.Session;
import nomo.harness.harness_tool_chat_contract.{Invocation, default_maximum, turn_error, combine};
import nomo.harness.read_tool_chat_contract.{turn_error as unicode_turn_error, extended_maximum, extended_turn_error, extended_combine, session_maximum, session_turn_error, session_combine, multi_maximum, multi_wide_maximum, multi_input_maximum, multi_input_reasoning_maximum, multi_large_maximum, multi_resilient_maximum, multi_turn_error, multi_bump, multi_settle, multi_combine};

// Policies account configured reservations. They never dispatch a model or retry.
public spec ChatBudgetPolicy {
    flow maximum(self) -> Ledger ![];
    flow turn_limit(self) -> i32 ![];
    flow validate_invocation(self, value: Invocation) -> string ![Error<IndexError>];
    flow reserve_stage(self, value: Ledger, call: bool) -> Result<Ledger, string> ![];
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![];
    flow combine(self, previous: Ledger, local: Ledger) -> Result<Ledger, string> ![];
    flow pending(self, phase: string) -> Ledger ![];
    flow child_pending(self) -> Ledger ![];
    flow parent_tokens(self) -> i32 ![];
    flow child_action_tokens(self) -> i32 ![];
    flow child_final_tokens(self) -> i32 ![];
    flow resilient_child(self) -> bool ![];
    flow high_input_child(self) -> bool ![];
    flow reasoning_child(self) -> bool ![];
    flow unicode_protocol(self) -> bool ![];
    flow multiple_tools(self) -> bool ![];
}

public enum SingleMode { Legacy, Unicode, Extended, Persistent }
public type SingleBudget = { mode: SingleMode };
public type MultiBudget = { turns: i32, parent: i32, resilient: bool, reasoning: bool, ceiling: Ledger };
public enum SelectedBudget { Single(SingleBudget), Multi(MultiBudget) }

impl SingleBudget ~ ChatBudgetPolicy {
    flow maximum(self) -> Ledger ![] {
        return match self.mode { SingleMode.Extended => extended_maximum(), SingleMode.Persistent => session_maximum(), _ => default_maximum() };
    }
    flow turn_limit(self) -> i32 ![] {
        return match self.mode { SingleMode.Extended => 4, SingleMode.Persistent => 32, _ => 2 };
    }
    flow validate_invocation(self, value: Invocation) -> string ![Error<IndexError>] {
        return match self.mode { SingleMode.Legacy => turn_error(value), SingleMode.Unicode => unicode_turn_error(value), SingleMode.Extended => extended_turn_error(value), SingleMode.Persistent => session_turn_error(value) };
    }
    flow reserve_stage(self, value: Ledger, call: bool) -> Result<Ledger, string> ![] { return bump(value, call); }
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![] { return settle(value, child); }
    flow combine(self, previous: Ledger, local: Ledger) -> Result<Ledger, string> ![] {
        return match self.mode { SingleMode.Extended => extended_combine(previous, local), SingleMode.Persistent => session_combine(previous, local), _ => combine(previous, local, self.maximum()) };
    }
    flow pending(self, phase: string) -> Ledger ![] { return pending(phase, false, 2048, 2048, 2048); }
    flow child_pending(self) -> Ledger ![] { return Ledger { steps = 3, calls = 2, tokens = 4096, tools = 1, scan = 16384 }; }
    flow parent_tokens(self) -> i32 ![] { return 2048; }
    flow child_action_tokens(self) -> i32 ![] { return 2048; }
    flow child_final_tokens(self) -> i32 ![] { return 2048; }
    flow resilient_child(self) -> bool ![] { return false; }
    flow high_input_child(self) -> bool ![] { return false; }
    flow reasoning_child(self) -> bool ![] { return false; }
    flow unicode_protocol(self) -> bool ![] { return self.mode != SingleMode.Legacy; }
    flow multiple_tools(self) -> bool ![] { return false; }
}

impl MultiBudget ~ ChatBudgetPolicy {
    flow maximum(self) -> Ledger ![] { return self.ceiling; }
    flow turn_limit(self) -> i32 ![] { return self.turns; }
    flow validate_invocation(self, value: Invocation) -> string ![Error<IndexError>] { return multi_turn_error(value, self.turns); }
    flow reserve_stage(self, value: Ledger, call: bool) -> Result<Ledger, string> ![] { return multi_bump(value, call, self.parent); }
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![] { return multi_settle(value, child, self.parent, self.resilient, self.reasoning); }
    flow combine(self, previous: Ledger, local: Ledger) -> Result<Ledger, string> ![] { return multi_combine(previous, local, self.ceiling); }
    flow pending(self, phase: string) -> Ledger ![] { return pending(phase, true, self.parent, self.child_action_tokens(), self.child_final_tokens()); }
    flow child_pending(self) -> Ledger ![] { return Ledger { steps = 7, calls = 4, tokens = self.child_final_tokens() + self.child_action_tokens() * 3, tools = 3, scan = 12583680 }; }
    flow parent_tokens(self) -> i32 ![] { return self.parent; }
    flow child_action_tokens(self) -> i32 ![] { return if self.reasoning { 16384 } else { 4096 }; }
    flow child_final_tokens(self) -> i32 ![] { return if self.resilient { 131072 } else { if self.reasoning { 16384 } else { 4096 } }; }
    flow resilient_child(self) -> bool ![] { return self.resilient; }
    flow high_input_child(self) -> bool ![] { return self.parent == 8192; }
    flow reasoning_child(self) -> bool ![] { return self.reasoning; }
    flow unicode_protocol(self) -> bool ![] { return true; }
    flow multiple_tools(self) -> bool ![] { return true; }
}

flow pending(phase: string, multi: bool, parent: i32, child_action: i32, child_final: i32) -> Ledger {
    let calls = if phase == "aggregate" { 0 } else { if multi { 5 } else { 3 } };
    let tools = if phase == "aggregate" { 0 } else { if multi { 3 } else { 1 } };
    let steps = if phase == "plan" { if multi { 10 } else { 6 } } else { if phase == "child" { if multi { 9 } else { 5 } } else { 0 } };
    return Ledger { steps = steps, calls = calls, tokens = if calls == 0 { 0 } else { if multi { parent + child_final + child_action * 3 } else { 6144 } }, tools = tools, scan = tools * if multi { 4194560 } else { 16384 } };
}

// This is the sole compatibility mapping from saved maxima to runtime policy.
public flow select(value: Invocation, unicode: bool) -> SelectedBudget {
    if unicode {
        if value.maximum == multi_input_reasoning_maximum(48) { return SelectedBudget.Multi(MultiBudget { turns = 48, parent = 8192, resilient = false, reasoning = true, ceiling = value.maximum }); }
        if value.maximum == multi_input_maximum(48) { return SelectedBudget.Multi(MultiBudget { turns = 48, parent = 8192, resilient = false, reasoning = false, ceiling = value.maximum }); }
        if value.maximum == multi_resilient_maximum(48) { return SelectedBudget.Multi(MultiBudget { turns = 48, parent = 131072, resilient = true, reasoning = false, ceiling = value.maximum }); }
        if value.maximum == multi_large_maximum(48) { return SelectedBudget.Multi(MultiBudget { turns = 48, parent = 131072, resilient = false, reasoning = false, ceiling = value.maximum }); }
        for turns in [2, 32, 48] limit Iterations(3) {
            if value.maximum == multi_wide_maximum(turns) { return SelectedBudget.Multi(MultiBudget { turns = turns, parent = 4096, resilient = false, reasoning = false, ceiling = value.maximum }); }
            if turns != 48 && value.maximum == multi_maximum(turns) { return SelectedBudget.Multi(MultiBudget { turns = turns, parent = 2048, resilient = false, reasoning = false, ceiling = value.maximum }); }
        }
        if value.maximum == session_maximum() { return SelectedBudget.Single(SingleBudget { mode = SingleMode.Persistent }); }
        if value.maximum == extended_maximum() { return SelectedBudget.Single(SingleBudget { mode = SingleMode.Extended }); }
    }
    return SelectedBudget.Single(SingleBudget { mode = if unicode { SingleMode.Unicode } else { SingleMode.Legacy } });
}
