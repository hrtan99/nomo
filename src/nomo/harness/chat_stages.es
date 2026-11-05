module nomo.harness.chat_stages;

import std.effects.Fs;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.core.conversation.State;
import nomo.model.model_tool_contract.LoopTurn;
import nomo.harness.harness_tool_chat_contract.{Context, Invocation, TurnResult};
import nomo.harness.legacy_chat_stages.LegacyChatStages;
import nomo.harness.read_tool_chat_controller.{run_turn_controller, run_private_turn_controller};

public spec ReadStages {
    flow main(self, context: Context) -> string ![];
    flow child(self, task: string, files: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn ![Fs.read<ReadOnlyRoot>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
}

// The controller performs operations; the composition boundary installs one handler.
public flow run_public<S ~ ReadStages>(stages: S, request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => { resume stages.main(context); }
        LegacyChatStages.child(task, files, selected, multi, resilient, high_input, reasoning) => { resume stages.child(task, files, selected, multi, resilient, high_input, reasoning); }
    };
}

public flow run_private<S ~ ReadStages>(stages: S, request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_private_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => { resume stages.main(context); }
        LegacyChatStages.child(task, files, selected, multi, resilient, high_input, reasoning) => { resume stages.child(task, files, selected, multi, resilient, high_input, reasoning); }
    };
}
