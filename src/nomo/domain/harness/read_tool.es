module nomo.domain.harness.read_tool;

import nomo.domain.harness.model_tool_contract.Limits;

public type ToolSelection = { operation: string, files: Array<string>, literal: string, text: string };

public enum LoopMode {
    Public(limits: Limits, work: bool, inspect: bool),
    Private(limits: Limits, work: bool),
    Chat(limits: Limits, redacted: bool),
    Expanded(wide: bool, high_input: bool),
    Multi(redacted: bool, resilient: bool, reasoning: bool),
}
