module nomo.domain.context;

import nomo.core.conversation.Event;
import nomo.domain.conversation.ModelTurn;
import nomo.domain.harness.loop.{Context, bounded_context_error};
import nomo.domain.limits.{context_bytes, message_bytes};
import nomo.domain.settings.{as_number, effective_window, estimated_tokens};
import nomo.domain.workspace.ProjectInstruction;
import std.agent.message.Message;
import std.collections.Set;
import std.json.{JsonValue, stringify};
import std.text.{char_count, len};

public enum Refusal {
    InvalidLimit,
    InvalidContext,
    InvalidText,
    Encoding,
    TooLarge
}

public type Measurement = {
    encoded: string,
    encoded_bytes: usize,
    tokens: Option<usize>
};

// Only the closed Context/string entry points below reach this encoder. Their
// JSON leaves are strings/bools, so the JsonValue roundtrip preserves the typed
// Prompt.data representation. Numeric/bytes/enum/generic input is unsupported.
flow encoded_measure(json: JsonValue, maximum_bytes: usize) -> Result<Measurement, Refusal> {
    let encoded = match stringify(json) {
        Ok(text) => text,
        Err(_) => {
            return Err(Refusal.Encoding);
        },
    };
    // Preserve scalar admission, then measure exact UTF-8 bytes without an encoded copy.
    if char_count(encoded) > maximum_bytes {
        return Err(Refusal.TooLarge);
    }
    let size = len(encoded);
    if size > maximum_bytes {
        return Err(Refusal.TooLarge);
    }
    return Ok(Measurement {
        encoded,
        encoded_bytes = size,
        tokens = None()
    });
}

// Measure the same concrete value the caller supplies to Prompt.data. Semantic
// confirmation and the existing stage budget/admission guards remain required.
public flow measure_context(context: Context, maximum_bytes: usize) -> Result<Measurement, Refusal> {
    if maximum_bytes > context_bytes() {
        return Err(Refusal.InvalidLimit);
    }
    if bounded_context_error(context) != "" {
        return Err(Refusal.InvalidContext);
    }
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion {
        Some(converted) => converted.body,
        None() => {
            return Err(Refusal.Encoding);
        },
    };
    return encoded_measure(json, maximum_bytes);
}

// This scalar ceiling bounds source allocation before conversion. It is not an
// estimate of encoded size or Provider tokens; escaping/UTF-8 are measured below.
public flow measure_text(text: string, maximum_bytes: usize) -> Result<Measurement, Refusal> {
    if maximum_bytes > context_bytes() {
        return Err(Refusal.InvalidLimit);
    }
    if char_count(text) > message_bytes() {
        return Err(Refusal.InvalidText);
    }
    let message = Message.new(text);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion {
        Some(converted) => converted.body,
        None() => {
            return Err(Refusal.Encoding);
        },
    };
    return encoded_measure(json, maximum_bytes);
}

public flow projection_project(input: ModelTurn) -> ModelTurn {
    let history = input.history.retain(item => item.role != "summary" && item.role != "archive");
    let instructions = input.instructions.extend(
        input.settings.instructions.iter().map(
            text =>
            ProjectInstruction {
                scope = ".",
                path = ".nomo.toml",
                text
            }
        ).collect()
    );
    return input {
        history,
        instructions
    };
}

public flow should_compact(input: ModelTurn, bytes: usize) -> bool {
    // A text estimate, not measured provider usage. Original events stay in SQLite.
    let requested = as_number(effective_window(input.settings)) * input.settings.compact_ratio;
    let available = as_number(effective_window(input.settings) - input.settings.max_output_tokens);
    let threshold = if requested < available {
        requested
    } else {
        available
    };
    return estimated_tokens(bytes) > threshold;
}

// Policy is supplied by the caller, never inferred from Model text or a receipt.
public enum EventPolicy {
    Task,
    ConfirmedParent,
    ToolOutcome,
    EditOriginal,
    EditBinding,
    ConfirmedOutcome,
    Required,
    Optional
}

public enum SelectionRefusal {
    InvalidPolicy,
    InvalidContext,
    InvalidLimit,
    Encoding,
    RequiredTooLarge
}

public type Selection = {
    context: Context,
    measurement: Measurement,
    selected: Array<usize>,
    omitted: Array<usize>,
    omitted_count: usize
};

flow optional(policy: EventPolicy) -> bool {
    return match policy {
        EventPolicy.Optional => true,
        EventPolicy.Task => false,
        EventPolicy.ConfirmedParent => false,
        EventPolicy.ToolOutcome => false,
        EventPolicy.EditOriginal => false,
        EventPolicy.EditBinding => false,
        EventPolicy.ConfirmedOutcome => false,
        EventPolicy.Required => false,
    };
}

flow protected(event: Event) -> bool {
    return event.role == "tool" || (event.role == "user" && (
        event.kind == "context"
            || event.kind == "input"
    )) || (event.role == "assistant" && event.kind == "final");
}

// Reproject from the original history so optional trials cannot reorder events.
flow selection_project(context: Context, indices: Set<usize>) -> Context {
    let history = context.history.iter().enumerate().filter_map(
        item => {
            let (index, event) = item;
            return if indices.contains(index) {
                Some(event)
            } else {
                None()
            };
        }
    ).collect();
    return context {
        history
    };
}

flow failure(error: Refusal) -> SelectionRefusal {
    return match error {
        Refusal.InvalidLimit => SelectionRefusal.InvalidLimit,
        Refusal.InvalidContext => SelectionRefusal.InvalidContext,
        Refusal.InvalidText => SelectionRefusal.InvalidContext,
        Refusal.Encoding => SelectionRefusal.Encoding,
        Refusal.TooLarge => SelectionRefusal.RequiredTooLarge,
    };
}

// Required values are indivisible. Optional values are tried whole in source
// order; a large omission does not prevent a later smaller event from fitting.
public flow select(context: Context, policies: Array<EventPolicy>, maximum_bytes: usize) -> Result<
    Selection,
    SelectionRefusal
> {
    if maximum_bytes > context_bytes() {
        return Err(SelectionRefusal.InvalidLimit);
    }
    if context.history.len() == 0 || context.history.len() > 32 || policies.len() != context.history.len() {
        return Err(SelectionRefusal.InvalidPolicy);
    }
    if bounded_context_error(context) != "" {
        return Err(SelectionRefusal.InvalidContext);
    }
    var indices: Set<usize> = Set.new();
    var task = false;
    var index: usize = 0;
    @limits([Iterations(32)]) for event in context.history {
        let policy = policies[index];
        if policy == EventPolicy.Task {
            task = true;
        }
        if optional(policy) {
            if protected(event) {
                return Err(SelectionRefusal.InvalidPolicy);
            }
        } else {
            indices = indices.insert(index);
        }
        index = index + 1;
    }
    if !task {
        return Err(SelectionRefusal.InvalidPolicy);
    }
    var measurement = match measure_context(selection_project(context, indices), maximum_bytes) {
        Ok(value) => value,
        Err(error) => {
            return Err(failure(error));
        },
    };
    index = 0;
    @limits([Iterations(32)]) for policy in policies {
        if optional(policy) {
            let trial = indices.insert(index);
            match measure_context(selection_project(context, trial), maximum_bytes) {
                Ok(value) => {
                    indices = trial;
                    measurement = value;
                },
                Err(error) => match error {
                    Refusal.TooLarge => (),
                    Refusal.InvalidLimit => {
                        return Err(SelectionRefusal.InvalidLimit);
                    },
                    Refusal.InvalidContext => {
                        return Err(SelectionRefusal.InvalidContext);
                    },
                    Refusal.InvalidText => {
                        return Err(SelectionRefusal.InvalidContext);
                    },
                    Refusal.Encoding => {
                        return Err(SelectionRefusal.Encoding);
                    },
                },
            }
        }
        index = index + 1;
    }
    var selected: Array<usize> = [];
    var omitted: Array<usize> = [];
    index = 0;
    @limits([Iterations(32)]) for event in context.history {
        if indices.contains(index) {
            selected = selected.push(index);
        }
        else {
            omitted = omitted.push(index);
        }
        index = index + 1;
    }
    return Ok(
        Selection {
            context = selection_project(context, indices),
            measurement,
            selected,
            omitted,
            omitted_count = omitted.len()
        }
    );
}
