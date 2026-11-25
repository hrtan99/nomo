module nomo.domain.context.projection;

import std.text.len as text_bytes;
import nomo.core.json.encode;
import nomo.domain.conversation.turn.Turn;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.context.instructions.ProjectInstruction;
import nomo.domain.configuration.settings.{effective_window, as_number, estimated_tokens};

public spec ContextProjection {
    flow bytes(self, input: Turn) -> usize ![];
    flow needs_compaction(self, input: Turn) -> bool ![];
}
public type RollingContext = {};

public flow project(input: Turn) -> Turn {
    var history: Array<ChatMessage> = [];
    for item in input.history limit Iterations(2147483647) {
        if item.role != "summary" && item.role != "archive" { history = history.push(item); }
    }
    var instructions = input.instructions;
    for text in input.settings.instructions limit Iterations(2147483647) {
        instructions = instructions.push(ProjectInstruction { scope = ".", path = ".nomo.toml", text = text });
    }
    return Turn { session = input.session, workspace = input.workspace, initial_request = input.initial_request,
        request = input.request, summary = input.summary, pending = input.pending, history = history,
        instructions = instructions, runs = input.runs, settings = input.settings, jobs = input.jobs };
}

impl RollingContext ~ ContextProjection {
    flow bytes(self, input: Turn) -> usize {
        let json = match encode(input, "context conversion failed", "context encoding failed") {
            Ok(value) => value, Err(error) => { abort(error); }
        };
        return text_bytes(json);
    }
    flow needs_compaction(self, input: Turn) -> bool {
        // A text estimate, not measured provider usage. Original events stay in SQLite.
        let requested = as_number(effective_window(input.settings)) * input.settings.compact_ratio;
        let available = as_number(effective_window(input.settings) - input.settings.max_output_tokens);
        let threshold = if requested < available { requested } else { available };
        return estimated_tokens(self.bytes(input)) > threshold;
    }
}
