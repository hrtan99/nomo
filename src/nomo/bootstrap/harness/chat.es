module nomo.bootstrap.harness.chat;

import nomo.application.harness.effects.model_harness_progress.HarnessProgress;
import nomo.application.harness.effects.model_conversation_output.ConversationOutput;
import nomo.application.harness.ports.model_conversation_output.ConversationSink;
import nomo.adapters.cli.legacy.console_progress.ConsoleProgress;
import nomo.adapters.cli.legacy.console_events.{PublicHarnessEvents, RedactedHarnessEvents};
import nomo.harness.harness_tool_chat_contract.Invocation;
import nomo.domain.harness.harness_tool_chat_contract.TurnResult;
import nomo.application.harness.loops.shared_chat_controller.run_mode;

// User-facing final answers are unchanged; progress omits arbitrary tool/task text.
public flow run_shared_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_output(PublicHarnessEvents {}, request, allowed, invocation, unicode);
}

public flow run_private_turn(request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    return run_output(RedactedHarnessEvents {}, request, allowed, invocation, unicode);
}

flow run_output<S ~ ConversationSink>(sink: S, request: string, allowed: Array<string>, invocation: Invocation, unicode: bool) -> TurnResult {
    let progress = ConsoleProgress {};
    return run_mode(request, allowed, invocation, unicode) with {
        ConversationOutput.publish(event) => sink.publish(event);
        HarnessProgress.write(line) => progress.write(line);
    };
}
