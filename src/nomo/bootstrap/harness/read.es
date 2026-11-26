module nomo.bootstrap.harness.read;

import nomo.application.harness.loops.child_loop_policy.{BoundedChild, ExpandedChild, MultiChild, LegacyChild};
import nomo.adapters.cli.legacy.console_events.{PublicChildEvents, RedactedChildEvents};
import nomo.adapters.cli.legacy.console_progress.{ConsoleProgress, SilentProgress};
import nomo.adapters.cli.legacy.console_diagnostics.ConsoleDiagnostics;
import nomo.domain.harness.model_tool_contract.{Session, Limits, LoopTurn};
import nomo.adapters.model.legacy.action_decoder.{LegacyActions, UnicodeActions};
import nomo.application.harness.loops.read_tool_controller.run_output;

public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_output(BoundedChild { limits, work, chat = false }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, inspect_all);
}

public flow run_private_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits, work = false, chat = false }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_private_work_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits, work = true, chat = false }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_public_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits, work = true, chat = true }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_private_chat_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session) -> LoopTurn {
    return run_output(BoundedChild { limits, work = true, chat = true }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_expanded_work_loop_controller(raw: string, allowed: Array<string>, previous: Session, wide: bool, high_input: bool) -> LoopTurn {
    return run_output(ExpandedChild { wide, high_input }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_public_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, resilient: bool, reasoning: bool) -> LoopTurn {
    return run_output(MultiChild { resilient, reasoning }, UnicodeActions {}, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_private_multi_chat_loop_controller(raw: string, allowed: Array<string>, previous: Session, resilient: bool, reasoning: bool) -> LoopTurn {
    return run_output(MultiChild { resilient, reasoning }, UnicodeActions {}, RedactedChildEvents {}, ConsoleProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, false);
}

public flow run_legacy_loop(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_output(LegacyChild { limits }, LegacyActions { work }, PublicChildEvents {}, SilentProgress {}, ConsoleDiagnostics {}, raw, allowed, previous, inspect_all);
}
