module nomo.agent.model_context;

import std.text.from_usize;
import std.io.println;
import nomo.core.conversation.{State, capacity_error};
import nomo.agent.loop.failure;
import nomo.model.model_tool_contract.{Session, Context, LoopTurn};
import nomo.context.selection.{EventPolicy, SelectionRefusal, select as select_context};

public flow history(session: Session, state: State) -> Session {
    return Session { history = state, calls = session.calls, tokens = session.tokens, tools = session.tools, scan = session.scan };
}

public flow failed(session: Session, message: string, status: i32) -> LoopTurn {
    let result = failure(session.history, message, status);
    return LoopTurn { state = history(session, result.state), status = status };
}

public flow capacity(session: Session, slots: usize, characters: usize) -> string {
    return capacity_error(session.history, slots, characters);
}

// Retain all task, parent, tool and confirmed outcome events. Only controller
// Model-text history is optional; state history/accounting is never rewritten.
public flow bounded_model_context(input: Context, maximum: usize) -> Result<Context, string> {
    var policies: Array<EventPolicy> = [];
    for event in input.history limit Iterations(32) {
        var policy = EventPolicy.Required;
        if event.role == "model" && event.kind == "text" { policy = EventPolicy.Optional; }
        if event.role == "user" && event.kind == "input" { policy = EventPolicy.Task; }
        policies = policies.push(policy);
    }
    let selected = match select_context(input, policies, maximum) {
        Ok(value) => value,
        Err(error) => {
            let message = match error {
                SelectionRefusal.InvalidPolicy => "invalid model context event policy",
                SelectionRefusal.InvalidContext => "invalid bounded model context",
                SelectionRefusal.InvalidLimit => "invalid model context byte limit",
                SelectionRefusal.Encoding => "model context encoding refused",
                SelectionRefusal.RequiredTooLarge => if maximum == 2048 { "required model context exceeds 2048 encoded UTF-8 bytes" } else { "required model context exceeds 33554432 encoded UTF-8 bytes" },
            };
            return Err(message);
        },
    };
    if selected.omitted_count > 0 {
        println("CONTEXT omitted " + from_usize(selected.omitted_count) + " optional history events; required facts retained.");
    }
    return Ok(selected.context);
}
