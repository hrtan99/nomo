module nomo.application.harness.read;

import nomo.application.harness.ports.{
    ChildLoopPolicy,
    ConversationOutput,
    ConversationSink,
    DiagnosticOutput,
    DiagnosticSink,
    Failure,
    HarnessProgress,
    LegacyChildModel,
    LegacyStringStages,
    ProgressSink,
    ReadContextBudget,
    ReadContextProgress,
    ReadContextValidation,
    Report,
    ToolActionDecoder
};
import nomo.application.harness.text.{emit, failure};
import nomo.application.workspace.ports.ReadTools;
import nomo.domain.context.{EventPolicy, SelectionRefusal, select};
import nomo.domain.conversation.{Event, State, add, capacity_error, charge, stop};
import nomo.domain.harness.loop.{
    Context,
    Limits,
    LoopTurn,
    ReadLedger,
    Session,
    Shape,
    allowed_error,
    budget_error,
    candidate_error,
    charge_action,
    context_error,
    fresh_loop,
    question_error,
    response_text,
    returned_text
};
import nomo.domain.harness.read.{
    Observed,
    ReadContext,
    bounded as read_bounded,
    bump,
    decode_read_plan,
    decode_work_plan,
    high_input_bump,
    high_input_settle,
    inspect_work,
    numbers,
    question_error as read_question_error,
    read_aggregate_error,
    read_context_error,
    read_inspect,
    read_validation_context_error,
    read_validation_inspect,
    settle,
    text_decode_plan,
    unicode_read_decode_plan,
    wide_bump,
    work_bump,
    work_plan_rejection,
    work_settle
};
import nomo.domain.limits.{
    child_answer_bytes,
    child_answer_frame_bytes,
    context_bytes,
    display_bytes,
    file_bytes,
    message_bytes,
    outcome_bytes,
    scan_bytes,
    scan_i32
};
import nomo.domain.text.{bounded, safe};
import nomo.domain.workspace.{Outcome, outcome, read_display_display};
import std.text.{char_count, contains, from_i32, from_usize};

public type BoundedChild = {
    limits: Limits,
    work: bool,
    chat: bool
};

public type ExpandedChild = {
    wide: bool,
    high_input: bool
};

public type MultiChild = {
    resilient: bool,
    reasoning: bool
};

public type LegacyChild = {
    limits: Limits
};

flow single_shape(input_characters: usize) -> Shape {
    return Shape {
        calls = 2,
        tools = 1,
        context_bytes = context_bytes(),
        input_characters,
        result_characters = display_bytes(),
        slots = 2,
        characters = message_bytes() + 64,
        tool_characters = outcome_bytes()
            + 20,
        whole_scope = false,
        partial_search = false,
        named_final = true,
        legacy_text = false
    };
}

public flow request_error(request: string, work: bool) -> string {
    if work {
        return if bounded(request, message_bytes()) {
            ""
        } else {
            "work delegation requires 1..1048576 safe UTF-8 bytes"
        };
    }
    return if bounded(request, message_bytes()) {
        ""
    } else {
        "question requires 1..1048576 safe UTF-8 bytes, not only spaces"
    };
}

flow charged(state: Session, tokens: usize, tool_scan: usize) -> Session {
    return Session {
        history = charge(state.history),
        calls = state.calls + if tool_scan == 0 {
            1
        } else {
            0
        },
        tokens = state.tokens + tokens,
        tools = state.tools + if tool_scan == 0 {
            0
        } else {
            1
        },
        scan = state.scan + tool_scan
    };
}

impl BoundedChild ~ ChildLoopPolicy {
    flow allowed_error(self, allowed: Array<string>) -> string {
        return candidate_error(allowed);
    }

    flow shape(self) -> Shape ![] {
        return single_shape(message_bytes());
    }

    flow request_error(self, request: string) -> string {
        return request_error(request, self.work);
    }

    flow validate_context(self, context: Context) -> string {
        return if self.chat {
            ""
        } else {
            context_error(context)
        };
    }

    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> {
        return reserve(state, self.limits, false);
    }

    flow reserve_tool(self, state: Session) -> Result<Session, string> {
        return reserve(state, self.limits, true);
    }
}

impl ExpandedChild ~ ChildLoopPolicy {
    flow allowed_error(self, allowed: Array<string>) -> string {
        return candidate_error(allowed);
    }

    flow shape(self) -> Shape ![] {
        return single_shape(message_bytes());
    }

    flow request_error(self, request: string) -> string {
        return request_error(request, true);
    }

    flow validate_context(self, context: Context) -> string {
        return context_error(context);
    }

    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> {
        let unit: usize = if self.high_input {
            131072
        } else {
            4096
        };
        if state.history.spent >= 3 || state.calls >= 2 || state.tokens != state.calls * unit
            || state.tools > 1 || state.scan > scan_bytes() {
            return Err("expanded work model reservation exhausted");
        }
        return Ok(charged(state, if self.high_input || (final_only && self.wide) {
            131072
        } else {
            4096
        }, 0));
    }

    flow reserve_tool(self, state: Session) -> Result<Session, string> {
        if state.tools != 0 || state.scan != 0 || state.history.spent >= 3 {
            return Err("expanded work tool reservation exhausted");
        }
        return Ok(charged(state, 0, scan_bytes()));
    }
}

impl MultiChild ~ ChildLoopPolicy {
    flow allowed_error(self, allowed: Array<string>) -> string {
        return candidate_error(allowed);
    }

    flow shape(self) -> Shape ![] {
        return Shape {
            calls = 4,
            tools = 3,
            context_bytes = context_bytes(),
            input_characters = message_bytes(),
            result_characters = display_bytes(),
            slots = 4,
            characters = outcome_bytes() + message_bytes()
                + 64,
            tool_characters = 0,
            whole_scope = true,
            partial_search = true,
            named_final = false,
            legacy_text = false
        };
    }

    flow request_error(self, request: string) -> string {
        return if bounded(request, message_bytes()) {
            ""
        } else {
            "invalid selected child context"
        };
    }

    flow validate_context(self, context: Context) -> string ![] {
        return "";
    }

    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> ![] {
        return Ok(
            charged(
                state,
                if self.resilient && (final_only || self.reasoning) {
                    131072
                } else {
                    if self.reasoning {
                        16384
                    } else {
                        4096
                    }
                },
                0
            )
        );
    }

    flow reserve_tool(self, state: Session) -> Result<Session, string> ![] {
        return Ok(charged(state, 0, 4194560));
    }
}

impl LegacyChild ~ ChildLoopPolicy {
    flow shape(self) -> Shape ![] {
        return Shape {
            calls = 2,
            tools = 1,
            context_bytes = context_bytes(),
            input_characters = message_bytes(),
            result_characters = 256,
            slots = 2,
            characters = message_bytes() + 64,
            tool_characters = outcome_bytes()
                + 20,
            whole_scope = false,
            partial_search = false,
            named_final = true,
            legacy_text = true
        };
    }

    flow allowed_error(self, allowed: Array<string>) -> string {
        return allowed_error(allowed);
    }

    flow request_error(self, request: string) -> string {
        return question_error(request);
    }

    flow validate_context(self, context: Context) -> string {
        return context_error(context);
    }

    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> {
        return reserve(state, self.limits, false);
    }

    flow reserve_tool(self, state: Session) -> Result<Session, string> {
        return reserve(state, self.limits, true);
    }
}

flow reserve(state: Session, limits: Limits, tool: bool) -> Result<Session, string> {
    let error = budget_error(state, limits, tool);
    if error != "" {
        return Err(error);
    }
    return Ok(charge_action(state, tool, limits));
}

public flow history(session: Session, state: State) -> Session {
    return session {
        history = state
    };
}

public flow model_context_failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn {
        state = history(session, result.state),
        status
    };
}

public flow capacity(session: Session, slots: usize, characters: usize) -> string {
    return capacity_error(session.history, slots, characters);
}

// Retain all task, parent, tool and confirmed outcome events. Only controller
// Model-text history is optional; state history/accounting is never rewritten.
public flow bounded_model_context(input: Context, maximum: usize) -> Result<Context, string> {
    var policies: Array<EventPolicy> = [];
    @limits([Iterations(32)]) for event in input.history {
        var policy = EventPolicy.Required;
        if event.role == "model" && event.kind == "text" {
            policy = EventPolicy.Optional;
        }
        if event.role == "user" && event.kind == "input" {
            policy = EventPolicy.Task;
        }
        policies = policies.push(policy);
    }
    let selected = match select(input, policies, maximum) {
        Ok(value) => value,
        Err(error) => {
            let message = match error {
                SelectionRefusal.InvalidPolicy => "invalid model context event policy",
                SelectionRefusal.InvalidContext => "invalid bounded model context",
                SelectionRefusal.InvalidLimit => "invalid model context byte limit",
                SelectionRefusal.Encoding => "model context encoding refused",
                SelectionRefusal.RequiredTooLarge => if maximum == 2048 {
                    "required model context exceeds 2048 encoded UTF-8 bytes"
                } else {
                    "required model context exceeds 33554432 encoded UTF-8 bytes"
                },
            };
            return Err(message);
        },
    };
    if selected.omitted_count > 0 {
        perform DiagnosticOutput.write(
            "CONTEXT omitted " + from_usize(selected.omitted_count)
                + " optional history events; required facts retained."
        );
    }
    return Ok(selected.context);
}

flow read_tool_controller_failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn {
        state = history(session, result.state),
        status
    };
}

flow tool_failure(result: Outcome) -> string {
    if contains(result.text, "file is not UTF-8") {
        return "non-UTF-8 file";
    }
    if contains(result.text, "file exceeds " + from_usize(file_bytes()) + " bytes")
        || contains(result.text, "file exceeds 262144 bytes")
        || contains(result.text, "file exceeds 65536 bytes")
        || contains(result.text, "file exceeds 16384 bytes")
        || contains(result.text, "file exceeds 2048 bytes") {
        return "per-file byte limit";
    }
    if contains(result.text, "file exceeds remaining scan allowance") {
        return "scan allowance";
    }
    if result.status == "truncated" {
        return "match limit";
    }
    return if result.status == "unsupported" {
        "unsupported output"
    } else {
        if result.status == "refused" {
            "refused input or limit"
        } else {
            "invalid tool outcome"
        }
    };
}

// Model -> typed action -> precharged tool -> observed result, shared by every policy.
flow run_policy<P ~ ChildLoopPolicy, D ~ ToolActionDecoder>(
    policy: P,
    decoder: D,
    raw: string,
    allowed: Array<string>,
    previous: Session,
    inspect_all: bool
) -> LoopTurn {
    if previous.history.stopped {
        return LoopTurn {
            state = previous,
            status = 4
        };
    }
    let shape = policy.shape();
    let initial = capacity(previous, 1, shape.input_characters);
    if initial != "" {
        return read_tool_controller_failed(history(previous, stop(previous.history)), initial, 4);
    }
    let invalid = policy.request_error(raw);
    if invalid != "" {
        return read_tool_controller_failed(previous, invalid, 2);
    }
    let paths = policy.allowed_error(allowed);
    if paths != "" {
        return read_tool_controller_failed(previous, paths, 2);
    }
    var session = history(previous, emit(previous.history, "user", "input", "", raw));
    var calls: usize = 0;
    var tools: usize = 0;
    @limits([Iterations(4)]) while calls < shape.calls {
        let final_only = tools == shape.tools;
        let full = capacity(session, shape.slots, shape.characters);
        if full != "" {
            return read_tool_controller_failed(history(session, stop(session.history)), full, 4);
        }
        let original = Context {
            history = session.history.events,
            allowed,
            final_only
        };
        let context = match bounded_model_context(original, shape.context_bytes) {
            Ok(value) => value,
            Err(error) => {
                return read_tool_controller_failed(session, error, 4);
            }
        };
        let error = policy.validate_context(context);
        if error != "" {
            return read_tool_controller_failed(session, error, 4);
        }
        session = match policy.reserve_model(session, final_only) {
            Ok(value) => value,
            Err(error) => {
                return read_tool_controller_failed(session, error, 4);
            }
        };
        session = history(session, emit(session.history, "model", "text", "qwen", ""));
        calls = calls + 1;
        let phase = if final_only {
            "read-child-final"
        } else {
            "read-child-action"
        };
        perform HarnessProgress.write(if final_only && shape.named_final {
            "CHILD STAGE model-final"
        } else {
            "CHILD STAGE model-action"
        });
        let response = perform LegacyChildModel.infer(context);
        if inspect_all {
            perform DiagnosticOutput.write(
                response_text(
                    response,
                    phase,
                    "lab-qwen-",
                    if final_only {
                        child_answer_frame_bytes()
                    } else {
                        384
                    }
                )
            );
        }
        let action = match decoder.decode(response, allowed, final_only) {
            Ok(value) => value,
            Err(error) => {
                let diagnostic = decoder.diagnostic(response, error, final_only);
                if diagnostic != "" {
                    perform DiagnosticOutput.write("CHILD MODEL REFUSAL " + diagnostic);
                }
                return read_tool_controller_failed(session, error, 3);
            }
        };
        if action.operation == "final" {
            return LoopTurn {
                state = history(session, emit(session.history, "assistant", "final", "", action.text)),
                status = 0
            };
        }
        if action.operation == "search" && action.files[0] == "*" && !shape.whole_scope {
            return read_tool_controller_failed(
                session,
                "whole-scope search requires a multi-step reservation",
                3
            );
        }
        if shape.tool_characters != 0 {
            let full = capacity(session, 2, char_count(response) + shape.tool_characters);
            if full != "" {
                return read_tool_controller_failed(history(session, stop(session.history)), full, 4);
            }
        }
        session = history(
            session,
            emit(session.history, "model", "request", action.operation, decoder.record(response))
        );
        session = match policy.reserve_tool(session) {
            Ok(value) => value,
            Err(error) => {
                return read_tool_controller_failed(session, error, 4);
            }
        };
        tools = tools + 1;
        perform HarnessProgress.write("CHILD STAGE tool");
        var files = action.files;
        if action.operation == "search" && files[0] == "*" {
            files = files.extend(allowed);
        }
        var result = if action.operation == "read" {
            read_display_display(perform ReadTools.read(files[0]))
        } else {
            read_display_display(perform ReadTools.search(files, action.literal))
        };
        if shape.legacy_text {
            if char_count(result.text) > outcome_bytes() {
                result = outcome("refused", "tool result exceeds 2097176 display characters", result.scanned);
            }
        } else if !safe(result.text, shape.result_characters) {
            result = outcome("refused", "tool result exceeds large-context display bound", result.scanned);
        }
        if result.status == "incomplete" {
            perform DiagnosticOutput.write("Search incomplete: results are partial; some candidates were skipped or the match limit was reached.");
        }
        let complete = result.status == "complete" || (
            shape.partial_search && action.operation == "search"
                && result.status == "incomplete"
        );
        if !complete {
            if shape.partial_search {
                perform DiagnosticOutput.write(
                    "CHILD TOOL FAILURE operation=" + action.operation
                        + " category=" + tool_failure(result)
                );
            }
            return LoopTurn {
                state = history(
                    session,
                    emit(
                        session.history,
                        "tool",
                        "error",
                        action.operation,
                        result.status + ": " + result.text
                    )
                ),
                status = 3
            };
        }
        session = history(
            session,
            emit(session.history, "tool", "complete", action.operation, result.status + ": " + result.text)
        );
    }
    return read_tool_controller_failed(session, "child model reservation exhausted", 4);
}

public flow run_output<
    P ~ ChildLoopPolicy,
    D ~ ToolActionDecoder,
    S ~ ConversationSink,
    O ~ ProgressSink,
    G ~ DiagnosticSink
>(
    policy: P,
    decoder: D,
    sink: S,
    progress: O,
    diagnostics: G,
    raw: string,
    allowed: Array<string>,
    previous: Session,
    inspect_all: bool
) -> LoopTurn {
    return run_policy(policy, decoder, raw, allowed, previous, inspect_all) with {
        ConversationOutput.publish(event) => sink.publish(event);
        HarnessProgress.write(line) => progress.write(line);
        DiagnosticOutput.write(line) => diagnostics.write(line);
    };
}

flow read_controller_failed(state: ReadLedger, error: string, resolved: bool) -> Result<Report, Failure> {
    return Err(Failure {
        state,
        error,
        resolved
    });
}

// Reservation, observation and validation are shared by all stage handlers.
public flow run_context_policy<
    P ~ ReadContextValidation + ReadContextBudget
        + ReadContextProgress
>(
    policy: P,
    request: string,
    allowed: Array<string>,
    initial: ReadLedger,
    prefix: string,
    require_tool: bool,
    inspect_plan: bool,
    inspect_all: bool
) -> Result<Report, Failure> {
    var state = initial;
    let invalid = policy.request_error(request);
    if invalid != "" {
        return read_controller_failed(state, invalid, true);
    }
    let invalid_allowed = allowed_error(allowed);
    if invalid_allowed != "" {
        return read_controller_failed(state, invalid_allowed, true);
    }
    let plan = ReadContext {
        phase = "plan",
        request,
        task = "",
        result = "",
        tool = "",
        outcome = "",
        allowed
    };
    let invalid_plan = policy.validate_context(plan);
    if invalid_plan != "" {
        return read_controller_failed(state, invalid_plan, true);
    }
    state = match policy.reserve(state, true) {
        Ok(value) => value,
        Err(error) => {
            return read_controller_failed(state, error, true);
        }
    };
    @limits([Iterations(2)]) for line in policy.progress("plan", state, prefix) {
        perform HarnessProgress.write(line);
    }
    let raw = perform LegacyStringStages.main(plan);
    if inspect_plan {
        perform HarnessProgress.write(returned_text(raw, "lab-qwen-"));
    }
    else if inspect_all {
        perform HarnessProgress.write(response_text(raw, "read-plan", "lab-qwen-", 384));
    }
    let task = match policy.decode(raw) {
        Ok(value) => value,
        Err(error) => {
            let rejected = policy.rejection(raw, error);
            if rejected != "" {
                perform HarnessProgress.write(rejected);
            }
            return read_controller_failed(state, error, true);
        }
    };
    if inspect_plan {
        return read_controller_failed(
            state,
            "read-plan inspection complete; no child, File or edit attempted",
            true
        );
    }
    state = match policy.reserve(state, false) {
        Ok(value) => value,
        Err(error) => {
            return read_controller_failed(state, error, true);
        }
    };
    perform HarnessProgress.write("EVENT main -> child-1 request child-1: " + task);
    let empty = fresh_loop();
    let selected = add(
        empty.history,
        Event {
            role = "user",
            kind = "context",
            name = "original",
            text = request
        }
    );
    @limits([Iterations(2)]) for line in policy.progress("child", state, prefix) {
        perform HarnessProgress.write(line);
    }
    let child = perform LegacyStringStages.child(task, allowed, selected);
    let observed = match policy.observe_child(child, request, task, allowed) {
        Ok(value) => value,
        Err(error) => {
            return read_controller_failed(state, error, false);
        }
    };
    state = match policy.settle_child(state, child.state) {
        Ok(value) => value,
        Err(error) => {
            return read_controller_failed(state, error, false);
        }
    };
    let allowance = policy.allowance();
    perform HarnessProgress.write(
        "SETTLED child-1 " + numbers(state) + " released_steps=" + from_i32(5 - state.steps)
            + " released_calls=" + from_i32(3 - state.calls) + " released_tokens="
            + from_i32(allowance.tokens - state.tokens) + " released_tools=" + from_i32(1 - state.tools)
            + " released_scan=" + from_i32(allowance.scan - state.scan) + " unresolved=false"
    );
    if child.status != 0 {
        return read_controller_failed(state, "child returned failure; no aggregation", true);
    }
    if require_tool && child.state.tools != 1 {
        return read_controller_failed(state, "work requires a successful read or search child", true);
    }
    let result_error = policy.result_error(observed.result);
    if result_error != "" {
        return read_controller_failed(state, result_error, true);
    }
    perform HarnessProgress.write("EVENT child-1 -> main result child-1: " + observed.result);
    state = match policy.reserve(state, false) {
        Ok(value) => value,
        Err(error) => {
            return read_controller_failed(state, error, true);
        }
    };
    perform HarnessProgress.write("EVENT main -> main consume child-1: " + observed.result);
    if observed.tool != "" {
        perform HarnessProgress.write("EVENT main -> main tool " + observed.tool + ": " + observed.outcome);
    }
    let aggregate = ReadContext {
        phase = "aggregate",
        request,
        task,
        result = observed.result,
        tool = observed.tool,
        outcome = observed.outcome,
        allowed
    };
    let invalid_aggregate = policy.validate_context(aggregate);
    if invalid_aggregate != "" {
        return read_controller_failed(state, invalid_aggregate, true);
    }
    state = match policy.reserve(state, true) {
        Ok(value) => value,
        Err(error) => {
            return read_controller_failed(state, error, true);
        }
    };
    @limits([Iterations(2)]) for line in policy.progress("aggregate", state, prefix) {
        perform HarnessProgress.write(line);
    }
    let answer = perform LegacyStringStages.main(aggregate);
    if inspect_all {
        perform HarnessProgress.write(response_text(answer, "read-aggregate", "lab-qwen-", 512));
    }
    let invalid_answer = policy.answer_error(answer);
    if invalid_answer != "" {
        return read_controller_failed(state, invalid_answer, true);
    }
    return Ok(
        Report {
            request,
            task,
            allowed,
            child = child.state,
            status = child.status,
            observed,
            answer,
            ledger = state
        }
    );
}

public flow stage(
    phase: string,
    state: ReadLedger,
    prefix: string,
    expanded: bool,
    wide: bool,
    high_input: bool,
    scan: i32
) -> Array<string> {
    let steps: i32 = match phase {
        "plan" => 6,
        "child" => 5,
        _ => 0
    };
    let calls = if phase == "aggregate" {
        0
    } else {
        3
    };
    let tools = if phase == "aggregate" {
        0
    } else {
        1
    };
    var lines = [
        "STAGE " + prefix + phase + " child-1 " + numbers(state) + " reserved_steps=" + from_i32(steps)
            + " reserved_calls=" + from_i32(calls) + " reserved_tokens=" + from_i32(
            if high_input
                && phase != "aggregate" {
                393216
            } else {
                if wide && phase != "aggregate" {
                    139264
                } else {
                    if expanded && phase != "aggregate" {
                        10240
                    } else {
                        calls * 2048
                    }
                }
            }
        ) + " reserved_tools=" + from_i32(tools) + " reserved_scan=" + from_i32(tools * scan)
    ];
    if phase == "child" {
        lines = lines.push(if high_input {
            "RESERVATION child-1 steps=3 calls=2 tokens=262144 tools=1 scan=" + from_i32(scan_i32())
                + " tail_steps=2 tail_calls=1 tail_tokens=131072 unresolved=true"
        } else {
            if wide {
                "RESERVATION child-1 steps=3 calls=2 tokens=135168 tools=1 scan=" + from_i32(scan_i32())
                    + " tail_steps=2 tail_calls=1 tail_tokens=4096 unresolved=true"
            } else {
                if expanded {
                    "RESERVATION child-1 steps=3 calls=2 tokens=8192 tools=1 scan=" + from_i32(scan_i32())
                        + " tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true"
                } else {
                    "RESERVATION child-1 steps=3 calls=2 tokens=4096 tools=1 scan=" + from_i32(scan)
                        + " tail_steps=2 tail_calls=1 tail_tokens=2048 unresolved=true"
                }
            }
        });
    }
    return lines;
}

public type UnicodeContext = {
    require_tool: bool,
    expanded: bool,
    wide: bool,
    high_input: bool
};

impl UnicodeContext ~ ReadContextValidation {
    flow request_error(self, value: string) -> string {
        return read_question_error(value);
    }

    flow validate_context(self, value: ReadContext) -> string {
        return read_validation_context_error(value);
    }

    flow decode(self, value: string) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return if self.require_tool {
            decode_work_plan(value)
        } else {
            unicode_read_decode_plan(value)
        };
    }

    flow rejection(self, raw: string, error: string) -> string {
        return if self.require_tool && error == "invalid bounded delegated task" {
            "READ_PLAN_REJECTION " + work_plan_rejection(raw)
        } else {
            ""
        };
    }

    flow observe_child(self, child: LoopTurn, request: string, task: string, allowed: Array<string>) -> Result<
        Observed,
        string
    > {
        return if self.require_tool {
            inspect_work(child.state, child.status, request, task, allowed)
        } else {
            read_validation_inspect(child.state, child.status, request, task, allowed)
        };
    }

    flow result_error(self, value: string) -> string {
        return if bounded(value, child_answer_bytes()) {
            ""
        } else {
            "invalid bounded child result"
        };
    }

    flow answer_error(self, value: string) -> string {
        return if bounded(value, message_bytes()) {
            ""
        } else {
            "invalid bounded final answer"
        };
    }
}

impl UnicodeContext ~ ReadContextBudget {
    flow reserve(self, value: ReadLedger, call: bool) -> Result<ReadLedger, string> ![] {
        return if self.high_input {
            high_input_bump(value, call)
        } else {
            if self.wide {
                wide_bump(value, call)
            } else {
                if self.expanded {
                    work_bump(value, call)
                } else {
                    bump(value, call)
                }
            }
        };
    }

    flow settle_child(self, value: ReadLedger, child: Session) -> Result<ReadLedger, string> ![] {
        return if self.high_input {
            high_input_settle(value, child)
        } else {
            if self.expanded {
                work_settle(value, child)
            } else {
                settle(value, child)
            }
        };
    }

    flow allowance(self) -> ReadLedger ![] {
        return ReadLedger {
            steps = 5,
            calls = 3,
            tokens = if self.high_input {
                393216
            } else {
                if self.wide {
                    139264
                } else {
                    if self.expanded {
                        10240
                    } else {
                        6144
                    }
                }
            },
            tools = 1,
            scan = if self.expanded {
                scan_i32()
            } else {
                16384
            }
        };
    }
}

impl UnicodeContext ~ ReadContextProgress {
    flow progress(self, phase: string, state: ReadLedger, prefix: string) -> Array<string> ![] {
        return stage(
            phase,
            state,
            prefix,
            self.expanded,
            self.wide,
            self.high_input,
            if self.expanded {
                scan_i32()
            } else {
                16384
            }
        );
    }
}

public type AsciiContext = {
    compatible: bool
};

impl AsciiContext ~ ReadContextValidation {
    flow request_error(self, value: string) -> string {
        return question_error(value);
    }

    flow validate_context(self, value: ReadContext) -> string {
        return read_context_error(value);
    }

    flow decode(self, value: string) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>] {
        return if self.compatible {
            decode_read_plan(value)
        } else {
            text_decode_plan(value)
        };
    }

    flow rejection(self, raw: string, error: string) -> string ![] {
        return "";
    }

    flow observe_child(self, child: LoopTurn, request: string, task: string, allowed: Array<string>) -> Result<
        Observed,
        string
    > {
        return read_inspect(child.state, child.status, request, task, allowed);
    }

    flow result_error(self, value: string) -> string {
        return if read_bounded(value, message_bytes()) {
            ""
        } else {
            "invalid bounded child result"
        };
    }

    flow answer_error(self, value: string) -> string {
        return if self.compatible {
            read_aggregate_error(value)
        } else {
            if read_bounded(value, message_bytes()) {
                ""
            } else {
                "invalid bounded final answer"
            }
        };
    }
}

impl AsciiContext ~ ReadContextBudget {
    flow reserve(self, value: ReadLedger, call: bool) -> Result<ReadLedger, string> ![] {
        return bump(value, call);
    }

    flow settle_child(self, value: ReadLedger, child: Session) -> Result<ReadLedger, string> ![] {
        return settle(value, child);
    }

    flow allowance(self) -> ReadLedger ![] {
        return ReadLedger {
            steps = 5,
            calls = 3,
            tokens = 6144,
            tools = 1,
            scan = 4096
        };
    }
}

impl AsciiContext ~ ReadContextProgress {
    flow progress(self, phase: string, state: ReadLedger, prefix: string) -> Array<string> ![] {
        return stage(phase, state, prefix, false, false, false, 4096);
    }
}
