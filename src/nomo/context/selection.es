module nomo.context.selection;

import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.model.tool_context.{Context, bounded_context_error};
import nomo.context.preflight.{Measurement, Refusal, measure_context};

// Policy is supplied by the caller, never inferred from Model text or a receipt.
public enum EventPolicy {
    Task, ConfirmedParent, ToolOutcome, EditOriginal, EditBinding,
    ConfirmedOutcome, Required, Optional
}
public enum SelectionRefusal { InvalidPolicy, InvalidContext, InvalidLimit, Encoding, RequiredTooLarge }
public type Selection = {
    context: Context, measurement: Measurement,
    selected: Array<usize>, omitted: Array<usize>, omitted_count: usize
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
    return event.role == "tool" ||
        (event.role == "user" && (event.kind == "context" || event.kind == "input")) ||
        (event.role == "assistant" && event.kind == "final");
}
flow includes(indices: Array<usize>, target: usize) -> bool {
    for index in indices limit Iterations(32) { if index == target { return true; } }
    return false;
}
// Reproject from the original history so optional trials cannot reorder events.
flow project(context: Context, indices: Array<usize>) -> Context {
    var history: Array<Event> = [];
    var index: usize = 0;
    for event in context.history limit Iterations(32) {
        if includes(indices, index) { history = history.push(event); }
        index = index + 1;
    }
    return Context { history = history, allowed = context.allowed, final_only = context.final_only };
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
public flow select(context: Context, policies: Array<EventPolicy>, maximum_bytes: usize) -> Result<Selection, SelectionRefusal> {
    if maximum_bytes > 8388608 { return Err(SelectionRefusal.InvalidLimit); }
    if count(context.history) == 0 || count(context.history) > 32 ||
        count(policies) != count(context.history) { return Err(SelectionRefusal.InvalidPolicy); }
    if bounded_context_error(context) != "" { return Err(SelectionRefusal.InvalidContext); }
    var indices: Array<usize> = [];
    var task = false;
    var index: usize = 0;
    for event in context.history limit Iterations(32) {
        let policy = policies[index];
        if policy == EventPolicy.Task { task = true; }
        if optional(policy) {
            if protected(event) { return Err(SelectionRefusal.InvalidPolicy); }
        } else { indices = indices.push(index); }
        index = index + 1;
    }
    if !task { return Err(SelectionRefusal.InvalidPolicy); }
    var measurement = match measure_context(project(context, indices), maximum_bytes) {
        Ok(value) => value,
        Err(error) => { return Err(failure(error)); },
    };
    index = 0;
    for policy in policies limit Iterations(32) {
        if optional(policy) {
            let trial = indices.push(index);
            match measure_context(project(context, trial), maximum_bytes) {
                Ok(value) => { indices = trial; measurement = value; },
                Err(error) => match error {
                    Refusal.TooLarge => {},
                    Refusal.InvalidLimit => { return Err(SelectionRefusal.InvalidLimit); },
                    Refusal.InvalidContext => { return Err(SelectionRefusal.InvalidContext); },
                    Refusal.InvalidText => { return Err(SelectionRefusal.InvalidContext); },
                    Refusal.Encoding => { return Err(SelectionRefusal.Encoding); },
                },
            }
        }
        index = index + 1;
    }
    var selected: Array<usize> = [];
    var omitted: Array<usize> = [];
    index = 0;
    for event in context.history limit Iterations(32) {
        if includes(indices, index) { selected = selected.push(index); }
        else { omitted = omitted.push(index); }
        index = index + 1;
    }
    return Ok(Selection { context = project(context, selected), measurement = measurement,
        selected = selected, omitted = omitted, omitted_count = count(omitted) });
}
