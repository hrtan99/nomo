module nomo.application.harness.loops.read_tool_controller;

import nomo.domain.context.large_context.{outcome_bytes, child_answer_frame_bytes, file_bytes};
import std.text.{char_count as len, contains, from_usize};
import nomo.domain.text.read_text.safe;
import nomo.domain.harness.model_plan_diagnostic.response_text;
import nomo.domain.conversation.state.stop;
import nomo.application.harness.ports.agent_child_loop_policy.ChildLoopPolicy;
import nomo.application.harness.loops.model_context.{capacity, history, bounded_model_context};
import nomo.application.harness.loops.conversation_events.{emit, failure};
import nomo.application.harness.effects.model_harness_progress.HarnessProgress;
import nomo.application.harness.ports.model_harness_progress.ProgressSink;
import nomo.application.harness.effects.model_diagnostic_output.DiagnosticOutput;
import nomo.application.harness.ports.model_diagnostic_output.DiagnosticSink;
import nomo.application.harness.effects.model_conversation_output.ConversationOutput;
import nomo.application.harness.ports.model_conversation_output.ConversationSink;
import nomo.domain.harness.model_tool_contract.{Session, LoopTurn};
import nomo.domain.harness.tool_context.Context;
import nomo.domain.context.read_contract.{outcome, Outcome};
import nomo.application.context.effects.tools_read_contract.ReadTools;
import nomo.domain.context.read_display.display;
import nomo.application.harness.ports.model_action_decoder.ToolActionDecoder;
import nomo.application.harness.effects.harness_legacy_string_stages.LegacyChildModel;

flow failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn { state = history(session, result.state), status };
}

flow tool_failure(result: Outcome) -> string {
    if contains(result.text, "file is not UTF-8") { return "non-UTF-8 file"; }
    if contains(result.text, "file exceeds " + from_usize(file_bytes()) + " bytes") || contains(result.text, "file exceeds 262144 bytes") || contains(result.text, "file exceeds 65536 bytes") || contains(result.text, "file exceeds 16384 bytes") || contains(result.text, "file exceeds 2048 bytes") { return "per-file byte limit"; }
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
    @limits([Iterations(4)]) while calls < shape.calls {
        let final_only = tools == shape.tools;
        let full = capacity(session, shape.slots, shape.characters);
        if full != "" { return failed(history(session, stop(session.history)), full, 4); }
        let original = Context { history = session.history.events, allowed, final_only };
        let context = match bounded_model_context(original, shape.context_bytes) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        let error = policy.validate_context(context); if error != "" { return failed(session, error, 4); }
        session = match policy.reserve_model(session, final_only) { Ok(value) => value, Err(error) => { return failed(session, error, 4); } };
        session = history(session, emit(session.history, "model", "text", "qwen", ""));
        calls = calls + 1;
        let phase = if final_only { "read-child-final" } else { "read-child-action" };
        perform HarnessProgress.write(if final_only && shape.named_final { "CHILD STAGE model-final" } else { "CHILD STAGE model-action" });
        let response = perform LegacyChildModel.infer(context);
        if inspect_all { perform DiagnosticOutput.write(response_text(response, phase, "lab-qwen-", if final_only { child_answer_frame_bytes() } else { 384 })); }
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
        if action.operation == "search" && files[0] == "*" { files = files.extend(allowed); }
        var result = if action.operation == "read" { display(perform ReadTools.read(files[0])) } else { display(perform ReadTools.search(files, action.literal)) };
        if shape.legacy_text {
            if len(result.text) > outcome_bytes() { result = outcome("refused", "tool result exceeds 2097176 display characters", result.scanned); }
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

public flow run_output<P ~ ChildLoopPolicy, D ~ ToolActionDecoder, S ~ ConversationSink, O ~ ProgressSink, G ~ DiagnosticSink>(policy: P, decoder: D, sink: S, progress: O, diagnostics: G, raw: string, allowed: Array<string>, previous: Session, inspect_all: bool) -> LoopTurn {
    return run_policy(policy, decoder, raw, allowed, previous, inspect_all) with {
        ConversationOutput.publish(event) => sink.publish(event);
        HarnessProgress.write(line) => progress.write(line);
        DiagnosticOutput.write(line) => diagnostics.write(line);
    };
}
