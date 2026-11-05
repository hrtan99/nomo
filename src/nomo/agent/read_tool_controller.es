module nomo.agent.read_tool_controller;

import std.text.{char_count as len, contains};
import nomo.core.read_text.{safe};
import nomo.harness.model_plan_diagnostic.{response_text};
import nomo.core.conversation.{ stop};
import nomo.agent.child_loop_policy.{ChildLoopPolicy, BoundedChild, ExpandedChild, MultiChild, LegacyChild};
import nomo.agent.model_context.{capacity, history, bounded_model_context};
import nomo.agent.conversation_events.{emit, failure};
import nomo.agent.console_events.{PublicChildEvents, RedactedChildEvents};
import nomo.agent.console_progress.{ConsoleProgress, SilentProgress};
import nomo.agent.console_diagnostics.ConsoleDiagnostics;
import nomo.model.harness_progress.{HarnessProgress, ProgressSink};
import nomo.model.diagnostic_output.{DiagnosticOutput, DiagnosticSink};
import nomo.model.conversation_output.{ConversationOutput, ConversationSink};
import nomo.model.model_tool_contract.{Session, Limits, Context};
import nomo.tools.read_contract.{outcome, Outcome, ReadTools};
import nomo.tools.read_display.display;
import nomo.model.action_decoder.{ToolActionDecoder, LegacyActions, UnicodeActions};
import nomo.harness.legacy_string_stages.LegacyChildModel;
public import nomo.model.model_tool_contract.LoopTurn;
flow failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn { state = history(session, result.state), status = status };
}

flow tool_failure(result: Outcome) -> string {
    if contains(result.text, "file is not UTF-8") { return "non-UTF-8 file"; }
    if contains(result.text, "file exceeds 262144 bytes") || contains(result.text, "file exceeds 65536 bytes") || contains(result.text, "file exceeds 16384 bytes") || contains(result.text, "file exceeds 2048 bytes") { return "per-file byte limit"; }
    if contains(result.text, "file exceeds remaining scan allowance") { return "scan allowance"; }
    if result.status == "truncated" { return "match limit"; }
    return if result.status == "unsupported" { "unsupported output" } else { if result.status == "refused" { "refused input or limit" } else { "invalid tool outcome" } };
}

// Model -> typed action -> precharged tool -> observed result, shared by every policy.
flow run_policy<P ~ ChildLoopPolicy, D ~ ToolActionDecoder>(policy: P, decoder: D, raw: string, allowed: Array<string>, previous: Session, inspect_all: bool) -> LoopTurn {
    if previous.history.stopped { return LoopTurn { state = previous, status = 4 }; }
    let shape = policy.shape();
    let initial = capacity(previous, 1, shape.input_characters);
    if initial != "" { return failed(history(previous, stop(previous.history)), initial, 4); }
    let invalid = policy.request_error(raw);
    if invalid != "" { return failed(previous, invalid, 2); }
    let paths = policy.allowed_error(allowed); if paths != "" { return failed(previous, paths, 2); }
    var session = history(previous, emit(previous.history, "user", "input", "", raw));
    var calls: usize = 0; var tools: usize = 0;
    while calls < shape.calls limit Iterations(4) {
        let final_only = tools == shape.tools;
        let full = capacity(session, shape.slots, shape.characters);
        if full != "" { return failed(history(session, stop(session.history)), full, 4); }
        let original = Context { history = session.history.events, allowed = allowed, final_only = final_only };
        let context = match bounded_model_context(original, shape.context_bytes) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        let error = policy.validate_context(context); if error != "" { return failed(session, error, 4); }
        session = match policy.reserve_model(session, final_only) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        session = history(session, emit(session.history, "model", "text", "qwen", ""));
        calls = calls + 1;
        let phase = if final_only { "read-child-final" } else { "read-child-action" };
        perform HarnessProgress.write(if final_only && shape.named_final { "CHILD STAGE model-final" } else { "CHILD STAGE model-action" });
        let response = perform LegacyChildModel.infer(context);
        if inspect_all { perform DiagnosticOutput.write(response_text(response, phase, "lab-qwen-", if final_only { 1152 } else { 384 })); }
        let action = match decoder.decode(response, allowed, final_only) { Ok(value) => value, Err(error) => {
            let diagnostic = decoder.diagnostic(response, error, final_only);
            if diagnostic != "" { perform DiagnosticOutput.write("CHILD MODEL REFUSAL " + diagnostic); }
            return failed(session, error, 3);
        } };
        if action.operation == "final" { return LoopTurn { state = history(session, emit(session.history, "assistant", "final", "", action.text)), status = 0 }; }
        if action.operation == "search" && action.files[0] == "*" && !shape.whole_scope { return failed(session, "whole-scope search requires a multi-step reservation", 3); }
        if shape.tool_characters != 0 {
            let full = capacity(session, 2, len(response) + shape.tool_characters);
            if full != "" { return failed(history(session, stop(session.history)), full, 4); }
        }
        session = history(session, emit(session.history, "model", "request", action.operation, decoder.record(response)));
        session = match policy.reserve_tool(session) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        tools = tools + 1;
        perform HarnessProgress.write("CHILD STAGE tool");
        var files = action.files;
        if action.operation == "search" && files[0] == "*" { for name in allowed limit Iterations(256) { files = files.push(name); } }
        var result = if action.operation == "read" { display(perform ReadTools.read(files[0])) } else { display(perform ReadTools.search(files, action.literal)) };
        if shape.result_characters == 256 {
            if len(result.text) > 256 { result = outcome("refused", "tool result exceeds 256 display characters", result.scanned); }
        } else if !safe(result.text, shape.result_characters) { result = outcome("refused", "tool result exceeds large-context display bound", result.scanned); }
        if result.status == "incomplete" { perform DiagnosticOutput.write("Search incomplete: results are partial; some candidates were skipped or the match limit was reached."); }
        let complete = result.status == "complete" || (shape.partial_search && action.operation == "search" && result.status == "incomplete");
        if !complete {
            if shape.partial_search { perform DiagnosticOutput.write("CHILD TOOL FAILURE operation=" + action.operation + " category=" + tool_failure(result)); }
            return LoopTurn { state = history(session, emit(session.history, "tool", "error", action.operation, result.status + ": " + result.text)), status = 3 };
        }
        session = history(session, emit(session.history, "tool", "complete", action.operation, result.status + ": " + result.text));
    }
    return failed(session, "child model reservation exhausted", 4);
}

public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_output(BoundedChild { limits = limits, work = work, chat = false }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, inspect_all);
}
public flow run_private_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits = limits, work = false, chat = false }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}
public flow run_private_work_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits = limits, work = true, chat = false }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}
public flow run_public_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits = limits, work = true, chat = true }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}
public flow run_private_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits = limits, work = true, chat = true }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}
public flow run_expanded_work_loop_controller(raw: string, allowed: Array<string>, previous: Session, wide: bool) -> LoopTurn {
    return run_output(ExpandedChild { wide = wide }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}
public flow run_public_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, resilient: bool) -> LoopTurn {
    return run_output(MultiChild { resilient = resilient }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}
public flow run_private_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, resilient: bool) -> LoopTurn {
    return run_output(MultiChild { resilient = resilient }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_output<P ~ ChildLoopPolicy, D ~ ToolActionDecoder, S ~ ConversationSink, O ~ ProgressSink, G ~ DiagnosticSink>(policy: P, decoder: D, sink: S, progress: O, diagnostics: G, raw: string, allowed: Array<string>, previous: Session, inspect_all: bool) -> LoopTurn {
    return run_policy(policy, decoder, raw, allowed, previous, inspect_all) with {
        ConversationOutput.publish(event) => { resume sink.publish(event); }
        HarnessProgress.write(line) => { resume progress.write(line); }
        DiagnosticOutput.write(line) => { resume diagnostics.write(line); }
    };
}

public flow run_legacy_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_output(LegacyChild { limits = limits }, LegacyActions { work = work }, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, inspect_all);
}
