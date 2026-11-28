module nomo.bootstrap.harness;

import nomo.adapters.cli.console.{
    ConsoleDiagnostics,
    ConsoleProgress,
    PublicChildEvents,
    PublicHarnessEvents,
    RedactedChildEvents,
    RedactedHarnessEvents,
    SilentProgress,
    ascii_read_finished,
    ascii_read_refused,
    precharged,
    publish,
    settled,
    text_delegation_refused,
    unicode_read_finished,
    unicode_read_refused,
    unresolved as console_unresolved,
    write
};
import nomo.adapters.codec.input;
import nomo.adapters.filesystem.workspace.{MultiFiles, StandardFiles, WideFiles, read_legacy, search_legacy};
import nomo.adapters.model.read.{
    MainMode,
    ascii_read_main_stage,
    harness_tool_chat_main_stage,
    infer_main,
    legacy_limits,
    main_mode,
    prompt_ChatMain,
    prompt_HistoryChatMain,
    unicode_read_main_stage,
    unresolved
};
import nomo.adapters.model.text.{delegation_child, delegation_main, main_stage};
import nomo.adapters.model.tool_loop.{
    LegacyActions,
    MultiModel,
    StandardModel,
    UnicodeActions,
    WorkModel,
    old_infer,
    work_infer
};
import nomo.application.harness.chat.run_mode;
import nomo.application.harness.ports.{
    ChatChildStage,
    ChildModel,
    ConversationOutput,
    ConversationSink,
    Failure,
    HarnessProgress,
    LegacyChatStages,
    LegacyChildModel,
    LegacyStringStages,
    ModelText,
    ReadStages,
    Report,
    TextDelegationOutput,
    TextDelegationStages,
    WideChatChildStage
};
import nomo.application.harness.read.{
    AsciiContext,
    BoundedChild,
    ExpandedChild,
    LegacyChild,
    MultiChild,
    UnicodeContext,
    run_context_policy,
    run_output as read_run_output
};
import nomo.application.harness.text.{
    emit as text_emit,
    failure as text_failure,
    harness_child_run,
    model_turn_controller,
    reject as text_reject,
    text_delegation_run,
    turn_controller
};
import nomo.application.workspace.ports.{FileReader, LiteralSearcher, ReadTools};
import nomo.core.conversation.{Event, State};
import nomo.domain.conversation.TextTurn;
import nomo.domain.harness.chat.{Context, TurnResult};
import nomo.domain.harness.delegation.{Job, Outcome, admit, settle};
import nomo.domain.harness.loop.{Limits, LoopMode, LoopTurn, Session, default_limits};
import nomo.domain.harness.read.read_fresh;
import nomo.harness.harness_tool_chat_contract.Invocation;
import nomo.harness.harness_tool_contract.Ledger;
import nomo.tools.workspace.ReadOnlyRoot;
import std.io.println;

// Exactly one synchronous child invocation; no retry, sibling or recursive route.
public flow harness_run(job: Job) -> Result<Outcome, string> {
    return match admit(job) {
        Err(error) => Err(error),
        Ok(reservation) => settle(reservation, harness_child_run(reservation.child)),
    };
}

// Both entries seed explicitly selected data; local counters are charged only
// under their owner's prior reservation. No previous tool is dispatched here.
public flow ascii_read_child_turn(task: string, allowed: Array<string>, selected: State) -> LoopTurn ~ ChatChildStage<ReadOnlyRoot> {
    let seeded = Session { history = selected, calls = 0, tokens = 0, tools = 0, scan = 0 };
    return model_tool_run_loop(task, allowed, legacy_limits(), seeded);
}

public flow ascii_read_work_child_turn(task: string, allowed: Array<string>, selected: State) -> LoopTurn {
    let seeded = Session { history = selected, calls = 0, tokens = 0, tools = 0, scan = 0 };
    return model_tool_run_work_loop(task, allowed, legacy_limits(), seeded);
}

public flow chain_child_turn(task: string, allowed: Array<string>, selected: State, inspect_all: bool) -> LoopTurn {
    let seeded = Session { history = selected, calls = 0, tokens = 0, tools = 0, scan = 0 };
    return run_chain_work_loop(task, allowed, legacy_limits(), seeded, inspect_all);
}

public flow ascii_read_run_context_with(request: string, allowed: Array<string>, initial: Ledger,
    prefix: string, require_tool: bool, compatible_plan: bool, inspect_plan: bool, inspect_all: bool) -> Result<Report, Failure> {
    return run_context_policy(AsciiContext { compatible = compatible_plan }, request, allowed, initial, prefix, require_tool, inspect_plan, inspect_all);
}

// Interpret progress once while leaving Model stages for the caller's Handler.
public flow ascii_read_run_context(request: string, allowed: Array<string>, initial: Ledger,
    prefix: string, require_tool: bool, compatible_plan: bool, inspect_plan: bool, inspect_all: bool) -> Result<Report, Failure> {
    return ascii_read_run_context_with(request, allowed, initial, prefix, require_tool, compatible_plan, inspect_plan, inspect_all) with {
        HarnessProgress.write(line) => write(line);
    };
}

public flow ascii_read_run(request: string, allowed: Array<string>) -> i32 {
    let result = ascii_read_run_context(request, allowed, read_fresh(), "", false, false, false, false) with {
        LegacyStringStages.main(context) => ascii_read_main_stage(context);
        LegacyStringStages.child(task, files, selected) => ascii_read_child_turn(task, files, selected);
    };
    let report = match result {
        Ok(value) => value,
        Err(failure) => { if !failure.resolved { return unresolved(failure.error); } return ascii_read_refused(failure.state, failure.error); }
    };
    println("FINAL " + report.answer);
    ascii_read_finished(report.ledger);
    return 0;
}

public flow harness_tool_chat_run_turn(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return ascii_chat_run_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => harness_tool_chat_main_stage(context);
        LegacyChatStages.child(task, files, selected, _, _, _, _) => ascii_read_child_turn(task, files, selected);
    };
}

// Both entries seed explicitly selected data; local counters are charged only
// under their owner's prior reservation. No previous tool is dispatched here.
flow seed(selected: State) -> Session { return Session { history = selected, calls = 0, tokens = 0, tools = 0, scan = 0 }; }

public flow unicode_read_child_turn(task: string, allowed: Array<string>, selected: State) -> LoopTurn ~ ChatChildStage<ReadOnlyRoot> {
    return read_model_run_loop(task, allowed, default_limits(), seed(selected));
}

public flow unicode_read_work_child_turn(task: string, allowed: Array<string>, selected: State) -> LoopTurn ~ ChatChildStage<ReadOnlyRoot> {
    return read_model_run_work_loop(task, allowed, default_limits(), seed(selected));
}

public flow chat_child_turn(task: string, allowed: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn {
    return if multi { run_multi_chat_loop(task, allowed, seed(selected), false, resilient, high_input, reasoning) } else { run_chat_loop(task, allowed, default_limits(), seed(selected), false) };
}

public flow private_chat_child_turn(task: string, allowed: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn {
    return if multi { run_multi_chat_loop(task, allowed, seed(selected), true, resilient, high_input, reasoning) } else { run_chat_loop(task, allowed, default_limits(), seed(selected), true) };
}

public flow expanded_work_child_turn(task: string, allowed: Array<string>, selected: State, wide: bool, high_input: bool) -> LoopTurn ~ WideChatChildStage<ReadOnlyRoot> {
    return run_expanded_work_loop(task, allowed, seed(selected), wide, high_input);
}

public flow unicode_read_run_context_with(request: string, allowed: Array<string>, initial: Ledger,
    prefix: string, require_tool: bool, compatible_plan: bool, inspect_plan: bool, inspect_all: bool) -> Result<Report, Failure> {
    return run_context_policy(UnicodeContext { require_tool, expanded = false, wide = false, high_input = false }, request, allowed, initial, prefix, require_tool, inspect_plan, inspect_all);
}

public flow run_expanded_context(request: string, allowed: Array<string>, initial: Ledger, wide: bool, high_input: bool) -> Result<Report, Failure> {
    return run_context_policy(UnicodeContext { require_tool = true, expanded = true, wide, high_input }, request, allowed, initial, "read-", true, false, false) with {
        HarnessProgress.write(line) => write(line);
    };
}

// Interpret progress once while leaving Model stages for the caller's Handler.
public flow unicode_read_run_context(request: string, allowed: Array<string>, initial: Ledger,
    prefix: string, require_tool: bool, compatible_plan: bool, inspect_plan: bool, inspect_all: bool) -> Result<Report, Failure> {
    return unicode_read_run_context_with(request, allowed, initial, prefix, require_tool, compatible_plan, inspect_plan, inspect_all) with {
        HarnessProgress.write(line) => write(line);
    };
}

public flow unicode_read_run(request: string, allowed: Array<string>) -> i32 {
    let result = unicode_read_run_context(request, allowed, read_fresh(), "", false, false, false, false) with {
        LegacyStringStages.main(context) => unicode_read_main_stage(context);
        LegacyStringStages.child(task, files, selected) => unicode_read_child_turn(task, files, selected);
    };
    let report = match result {
        Ok(value) => value,
        Err(failure) => { if !failure.resolved { return console_unresolved(failure.error); } return unicode_read_refused(failure.state, failure.error); }
    };
    println("FINAL " + report.answer);
    unicode_read_finished(report.ledger);
    return 0;
}

type PublicStages = { mode: MainMode };

impl PublicStages ~ ReadStages {
    flow main(self, context: Context) -> string ![] { return infer_main(self.mode, Prompt.new().system(prompt_ChatMain()).data(input(context))); }
    flow child(self, task: string, files: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn { return chat_child_turn(task, files, selected, multi, resilient, high_input, reasoning); }
}

type PrivateStages = { mode: MainMode };

impl PrivateStages ~ ReadStages {
    flow main(self, context: Context) -> string ![] { return infer_main(self.mode, Prompt.new().system(prompt_ChatMain()).data(input(context))); }
    flow child(self, task: string, files: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn { return private_chat_child_turn(task, files, selected, multi, resilient, high_input, reasoning); }
}

type HistoryStages = { mode: MainMode, history: Array<Event> };

impl HistoryStages ~ ReadStages {
    flow main(self, context: Context) -> string ![] { return infer_main(self.mode, Prompt.new().system(prompt_HistoryChatMain()).data(input(ConversationInput { current = context, history = self.history }))); }
    flow child(self, task: string, files: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn { return private_chat_child_turn(task, files, selected, multi, resilient, high_input, reasoning); }
}

public flow read_tool_chat_run_turn(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_public(PublicStages { mode = main_mode(invocation) }, request, allowed, invocation);
}

public flow read_tool_chat_run_private_turn(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_private(PrivateStages { mode = main_mode(invocation) }, request, allowed, invocation);
}

public flow run_with_history(request: string, allowed: Array<string>, invocation: Invocation, history: Array<Event>) -> TurnResult {
    return run_private(HistoryStages { mode = main_mode(invocation), history }, request, allowed, invocation);
}

public flow model_tool_run_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return model_tool_run_loop_with(raw, allowed, limits, previous, false, false) with {
        LegacyChildModel.infer(context) => old_infer(context);
    };
}

public flow model_tool_run_work_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return model_tool_run_loop_with(raw, allowed, limits, previous, false, false) with {
        LegacyChildModel.infer(context) => work_infer(context);
    };
}

public flow run_chain_work_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session, inspect_all: bool) -> LoopTurn {
    return model_tool_run_loop_with(raw, allowed, limits, previous, true, inspect_all) with {
        LegacyChildModel.infer(context) => work_infer(context);
    };
}

// Compatibility composition: callers may still supply the Model handler.
// The reusable controller receives both operations without native bindings.
public flow model_tool_run_loop_with(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return legacy_model_tool_run_loop_controller(raw, allowed, limits, previous, work, inspect_all) with {
        ReadTools.read(name) => read_legacy(name);
        ReadTools.search(names, literal) => search_legacy(names, literal);
    };
}

public flow model_turn(raw: string, maximum: i32, budget: i32, previous: State) -> TextTurn {
    return model_turn_controller(raw, maximum, budget, previous) with {
        ModelText.infer(context) => main_stage(context);
        ConversationOutput.publish(event) => publish(event);
    };
}

flow selected(mode: LoopMode, raw: string, allowed: Array<string>, previous: Session) -> LoopTurn {
    return match mode {
        LoopMode.Public(limits, work, inspect) => read_run_loop_controller(raw, allowed, limits, previous, work, inspect),
        LoopMode.Private(limits, work) => if work { run_private_work_loop_controller(raw, allowed, limits, previous) } else { run_private_loop_controller(raw, allowed, limits, previous) },
        LoopMode.Chat(limits, hidden) => if hidden { run_private_chat_loop_controller(raw, allowed, limits, previous) } else { run_public_chat_loop_controller(raw, allowed, limits, previous) },
        LoopMode.Expanded(wide, high_input) => run_expanded_work_loop_controller(raw, allowed, previous, wide, high_input),
        LoopMode.Multi(hidden, resilient, reasoning) => if hidden { run_private_multi_chat_loop_controller(raw, allowed, previous, resilient, reasoning) } else { run_public_multi_chat_loop_controller(raw, allowed, previous, resilient, reasoning) },
    };
}

flow run_tools<F ~ FileReader<ReadOnlyRoot>, S ~ LiteralSearcher<ReadOnlyRoot>>(reader: F, searcher: S, mode: LoopMode, raw: string, allowed: Array<string>, previous: Session) -> LoopTurn {
    return selected(mode, raw, allowed, previous) with {
        ReadTools.read(name) => reader.read(name);
        ReadTools.search(names, literal) => searcher.search(names, literal);
    };
}

flow run_native<M ~ ChildModel, F ~ FileReader<ReadOnlyRoot>, S ~ LiteralSearcher<ReadOnlyRoot>>(model: M, reader: F, searcher: S, mode: LoopMode, raw: string, allowed: Array<string>, previous: Session) -> LoopTurn {
    return run_tools(reader, searcher, mode, raw, allowed, previous) with {
        LegacyChildModel.infer(context) => model.infer(context);
    };
}

public flow read_model_run_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_native(StandardModel {}, StandardFiles {}, StandardFiles {}, LoopMode.Public(limits, false, false), raw, allowed, previous);
}

public flow read_model_run_work_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_native(StandardModel {}, StandardFiles {}, StandardFiles {}, LoopMode.Public(limits, true, false), raw, allowed, previous);
}

// Compatibility composition leaves the model operation for its caller.
public flow read_model_run_loop_with(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_tools(StandardFiles {}, StandardFiles {}, LoopMode.Public(limits, work, inspect_all), raw, allowed, previous);
}

public flow run_private_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_native(StandardModel {}, StandardFiles {}, StandardFiles {}, LoopMode.Private(limits, false), raw, allowed, previous);
}

public flow run_private_work_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_native(StandardModel {}, StandardFiles {}, StandardFiles {}, LoopMode.Private(limits, true), raw, allowed, previous);
}

public flow run_chat_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session, redacted: bool) -> LoopTurn {
    return run_native(StandardModel {}, StandardFiles {}, StandardFiles {}, LoopMode.Chat(limits, redacted), raw, allowed, previous);
}

public flow run_expanded_work_loop(raw: string, allowed: Array<string>, previous: Session, wide: bool, high_input: bool) -> LoopTurn {
    return run_native(WorkModel { wide, high_input }, WideFiles {}, WideFiles {}, LoopMode.Expanded(wide, high_input), raw, allowed, previous);
}

public flow run_multi_chat_loop(raw: string, allowed: Array<string>, previous: Session, redacted: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn {
    return run_native(MultiModel { resilient, high_input, reasoning }, WideFiles {}, MultiFiles {}, LoopMode.Multi(redacted, resilient, reasoning), raw, allowed, previous);
}

public flow ascii_chat_run_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_shared_turn(request, allowed, invocation, false);
}

// User-facing final answers are unchanged; progress omits arbitrary tool/task text.
public flow run_shared_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_output(PublicHarnessEvents {}, request, allowed, invocation, unicode);
}

public flow chat_run_private_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_output(RedactedHarnessEvents {}, request, allowed, invocation, unicode);
}

flow run_output<S ~ ConversationSink>(sink: S, request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    let progress = ConsoleProgress {};
    return run_mode(request, allowed, invocation, unicode) with {
        ConversationOutput.publish(event) => sink.publish(event);
        HarnessProgress.write(line) => progress.write(line);
    };
}

public flow legacy_model_tool_run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_legacy_loop(raw, allowed, limits, previous, work, inspect_all);
}

public flow read_run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return read_run_output(BoundedChild { limits, work, chat = false }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, inspect_all);
}

public flow run_private_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return read_run_output(BoundedChild { limits, work = false, chat = false }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_private_work_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return read_run_output(BoundedChild { limits, work = true, chat = false }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_public_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return read_run_output(BoundedChild { limits, work = true, chat = true }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_private_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return read_run_output(BoundedChild { limits, work = true, chat = true }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_expanded_work_loop_controller(raw: string, allowed: Array<string>, previous: Session, wide: bool, high_input: bool) -> LoopTurn {
    return read_run_output(ExpandedChild { wide, high_input }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_public_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, resilient: bool, reasoning: bool) -> LoopTurn {
    return read_run_output(MultiChild { resilient, reasoning }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_private_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, resilient: bool, reasoning: bool) -> LoopTurn {
    return read_run_output(MultiChild { resilient, reasoning }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_legacy_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return read_run_output(LegacyChild { limits }, LegacyActions { work }, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, inspect_all);
}

// The controller performs operations; the composition boundary installs one handler.
public flow run_public<S ~ ReadStages>(stages: S, request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return utf8_chat_run_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => stages.main(context);
        LegacyChatStages.child(task, files, selected, multi, resilient, high_input, reasoning) => stages.child(task, files, selected, multi, resilient, high_input, reasoning);
    };
}

public flow run_private<S ~ ReadStages>(stages: S, request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_private_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => stages.main(context);
        LegacyChatStages.child(task, files, selected, multi, resilient, high_input, reasoning) => stages.child(task, files, selected, multi, resilient, high_input, reasoning);
    };
}

public flow emit(state: State, role: string, kind: string, name: string, text: string) -> State {
    return text_emit(state, role, kind, name, text) with {
        ConversationOutput.publish(event) => publish(event);
    };
}

public flow failure(state: State, message: string, status: i32) -> TextTurn {
    return text_failure(state, message, status) with {
        ConversationOutput.publish(event) => publish(event);
    };
}

public flow reject(state: State, message: string) -> TextTurn {
    return text_reject(state, message) with {
        ConversationOutput.publish(event) => publish(event);
    };
}

public flow turn(raw: string, maximum: i32, budget: i32, previous: State) -> TextTurn {
    return turn_controller(raw, maximum, budget, previous) with {
        ConversationOutput.publish(event) => publish(event);
    };
}

public flow utf8_chat_run_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_shared_turn(request, allowed, invocation, true);
}

public flow run_private_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return chat_run_private_turn(request, allowed, invocation, true);
}

public type ConversationInput = { current: Context, history: Array<Event> };

public flow run_text(request: string) -> i32 {
    return text_delegation_run(request) with {
        TextDelegationStages.main(context) => delegation_main(context);
        TextDelegationStages.child(context) => delegation_child(context);
        TextDelegationOutput.precharged(phase, state) => precharged(phase, state);
        TextDelegationOutput.settled(state) => settled(state);
        TextDelegationOutput.refused(state, error) => text_delegation_refused(state, error);
        TextDelegationOutput.line(text) => println(text);
    };
}
