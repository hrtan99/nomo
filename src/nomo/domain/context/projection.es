module nomo.domain.context.projection;

import nomo.domain.configuration.settings.{effective_window, as_number, estimated_tokens};
import nomo.domain.conversation.turn.Turn;
import nomo.domain.context.instructions.ProjectInstruction;

public flow project(input: Turn) -> Turn {
    let history = input.history.retain(item => item.role != "summary" && item.role != "archive");
    let instructions = input.instructions.extend(input.settings.instructions.iter().map(text =>
        ProjectInstruction { scope = ".", path = ".nomo.toml", text }
    ).collect());
    return input { history, instructions };
}

public flow should_compact(input: Turn, bytes: usize) -> bool {
    // A text estimate, not measured provider usage. Original events stay in SQLite.
    let requested = as_number(effective_window(input.settings)) * input.settings.compact_ratio;
    let available = as_number(effective_window(input.settings) - input.settings.max_output_tokens);
    let threshold = if requested < available { requested } else { available };
    return estimated_tokens(bytes) > threshold;
}
