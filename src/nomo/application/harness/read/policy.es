module nomo.application.harness.read.policy;

import std.text.from_i32;
import nomo.application.harness.read.ports.{ReadContextValidation, ReadContextBudget, ReadContextProgress};
import nomo.domain.context.large_context.{message_bytes, scan_i32, child_answer_bytes};
import nomo.domain.text.read_text.bounded;
import nomo.domain.harness.model_tool_contract.{Session, LoopTurn, question_error as legacy_question_error};
import nomo.domain.harness.read_protocol.{question_error, decode_plan, decode_work_plan, work_plan_rejection};
import nomo.domain.harness.harness_model_contract.{bounded as legacy_bounded, decode_plan as legacy_decode_plan, decode_read_plan as legacy_decode_read_plan, read_aggregate_error as legacy_aggregate_error};
import nomo.domain.harness.harness_tool_contract.{Context, Observed, bump, settle, numbers, work_bump, wide_bump, high_input_bump, work_settle, high_input_settle, context_error as legacy_context_error, inspect as legacy_inspect};
import nomo.harness.harness_tool_contract.Ledger;
import nomo.domain.harness.read_tool_contract.{inspect, inspect_work, context_error};

public flow stage(phase: string, state: Ledger, prefix: string, expanded: bool, wide: bool, high_input: bool, scan: i32) -> Array<string> {
    let steps: i32 = match phase { "plan" => 6, "child" => 5, _ => 0 };
    let calls = if phase == "aggregate" { 0 } else { 3 };
    let tools = if phase == "aggregate" { 0 } else { 1 };
    var lines = ["STAGE " + prefix + phase + " child-1 " + numbers(state) + " reserved_steps=" + from_i32(steps) +
        " reserved_calls=" + from_i32(calls) + " reserved_tokens=" + from_i32(if high_input && phase != "aggregate" { 393216 } else { if wide && phase != "aggregate" { 139264 } else { if expanded && phase != "aggregate" { 10240 } else { calls * 2048 } } }) +
        " reserved_tools=" + from_i32(tools) + " reserved_scan=" + from_i32(tools * scan)];
    if phase == "child" {
        lines = lines.push(if high_input { "RESERVATION child-1 steps=3 calls=2 tokens=262144 tools=1 scan=" + from_i32(scan_i32()) + " tail_steps=2 tail_calls=1 tail_tokens=131072 unresolved=true" } else { if wide { "RESERVATION child-1 steps=3 calls=2 tokens=135168 tools=1 scan=" + from_i32(scan_i32()) + " tail_steps=2 tail_calls=1 tail_tokens=4096 unresolved=true" } else { if expanded { "RESERVATION child-1 steps=3 calls=2 tokens=8192 tools=1 scan=" + from_i32(scan_i32()) + " tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true" } else { "RESERVATION child-1 steps=3 calls=2 tokens=4096 tools=1 scan=" + from_i32(scan) + " tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true" } } });
    }
    return lines;
}

public type UnicodeContext = { require_tool: bool, expanded: bool, wide: bool, high_input: bool };
impl UnicodeContext ~ ReadContextValidation {
    flow request_error(self, value: string) -> string { return question_error(value); }
    flow validate_context(self, value: Context) -> string { return context_error(value); }
    flow decode(self, value: string) -> Result<string, string> ![Error<IndexError>] { return if self.require_tool { decode_work_plan(value) } else { decode_plan(value) }; }
    flow rejection(self, raw: string, error: string) -> string { return if self.require_tool && error == "invalid bounded delegated task" { "READ_PLAN_REJECTION " + work_plan_rejection(raw) } else { "" }; }
    flow observe_child(self, child: LoopTurn, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> { return if self.require_tool { inspect_work(child.state, child.status, request, task, allowed) } else { inspect(child.state, child.status, request, task, allowed) }; }
    flow result_error(self, value: string) -> string { return if bounded(value, child_answer_bytes()) { "" } else { "invalid bounded child result" }; }
    flow answer_error(self, value: string) -> string { return if bounded(value, message_bytes()) { "" } else { "invalid bounded final answer" }; }
}
impl UnicodeContext ~ ReadContextBudget {
    flow reserve(self, value: Ledger, call: bool) -> Result<Ledger, string> ![] { return if self.high_input { high_input_bump(value, call) } else { if self.wide { wide_bump(value, call) } else { if self.expanded { work_bump(value, call) } else { bump(value, call) } } }; }
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![] { return if self.high_input { high_input_settle(value, child) } else { if self.expanded { work_settle(value, child) } else { settle(value, child) } }; }
    flow allowance(self) -> Ledger ![] { return Ledger { steps = 5, calls = 3, tokens = if self.high_input { 393216 } else { if self.wide { 139264 } else { if self.expanded { 10240 } else { 6144 } } }, tools = 1, scan = if self.expanded { scan_i32() } else { 16384 } }; }
}
impl UnicodeContext ~ ReadContextProgress {
    flow progress(self, phase: string, state: Ledger, prefix: string) -> Array<string> ![] { return stage(phase, state, prefix, self.expanded, self.wide, self.high_input, if self.expanded { scan_i32() } else { 16384 }); }
}

public type AsciiContext = { compatible: bool };
impl AsciiContext ~ ReadContextValidation {
    flow request_error(self, value: string) -> string { return legacy_question_error(value); }
    flow validate_context(self, value: Context) -> string { return legacy_context_error(value); }
    flow decode(self, value: string) -> Result<string, string> ![Error<IndexError>] { return if self.compatible { legacy_decode_read_plan(value) } else { legacy_decode_plan(value) }; }
    flow rejection(self, raw: string, error: string) -> string ![] { return ""; }
    flow observe_child(self, child: LoopTurn, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> { return legacy_inspect(child.state, child.status, request, task, allowed); }
    flow result_error(self, value: string) -> string { return if legacy_bounded(value, message_bytes()) { "" } else { "invalid bounded child result" }; }
    flow answer_error(self, value: string) -> string { return if self.compatible { legacy_aggregate_error(value) } else { if legacy_bounded(value, message_bytes()) { "" } else { "invalid bounded final answer" } }; }
}
impl AsciiContext ~ ReadContextBudget {
    flow reserve(self, value: Ledger, call: bool) -> Result<Ledger, string> ![] { return bump(value, call); }
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![] { return settle(value, child); }
    flow allowance(self) -> Ledger ![] { return Ledger { steps = 5, calls = 3, tokens = 6144, tools = 1, scan = 4096 }; }
}
impl AsciiContext ~ ReadContextProgress {
    flow progress(self, phase: string, state: Ledger, prefix: string) -> Array<string> ![] { return stage(phase, state, prefix, false, false, false, 4096); }
}
