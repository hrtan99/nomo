module app.provider_stage_probe;

import std.io.println;
import std.text.split;
import nomo.core.conversation.{Event, State};
import nomo.agent.conversation_events.Turn;
import nomo.agent.provider_controller.model_turn_controller;
import nomo.agent.provider.Context as LegacyContext;
import nomo.model.text_stage.{Context, ModelText};
import nomo.model.conversation_output.ConversationOutput;
import nomo.agent.console_events.publish;
import nomo.tools.edit_encoding.json;

type Case = { label: string, raw: string, maximum: i32, budget: i32, initial: State, reply: string,
    model_expected: bool, context: Context, expected: Turn };
flow slash() -> string { return split("\\/", "")[1]; }
flow collect(event: Event) -> unit {
    let encoded = match json([event.role, event.kind, event.name, event.text]) { Ok(value) => value, Err(_) => { abort("collector encoding refused"); } };
    println("EVENT " + encoded);
}
flow execute(item: Case, initial: State, console: bool) -> Turn {
    if console {
        return model_turn_controller(item.raw, item.maximum, item.budget, initial) with {
            ModelText.infer(value) => {
                if !item.model_expected || value != item.context { abort("model context or dispatch changed"); }
                println("PORT model"); resume item.reply;
            }
            ConversationOutput.publish(value) => { resume publish(value); }
        };
    }
    return model_turn_controller(item.raw, item.maximum, item.budget, initial) with {
        ModelText.infer(value) => {
            if !item.model_expected || value != item.context { abort("model context or dispatch changed"); }
            println("PORT model"); resume item.reply;
        }
        ConversationOutput.publish(value) => { resume collect(value); }
    };
}
flow verify(item: Case, initial: State, console: bool) -> Turn {
    println("CASE " + item.label + if console { " console" } else { " collector" });
    let actual = execute(item, initial, console);
    if actual != item.expected { abort("whole returned Turn changed"); }
    println("PASS " + item.label);
    return actual;
}
public flow unhandled(raw: string, maximum: i32, budget: i32, previous: State) -> Turn {
    return model_turn_controller(raw, maximum, budget, previous);
}
public flow observe(args: Array<string>) -> i32 {
    let canonical = Context { history = [], request = "compat" };
    let old: LegacyContext = canonical;
    if old != canonical { abort("provider Context compatibility changed"); }
    println("PASS provider_context_compatibility");
    __CASES__
    __TWO_TURNS__
    return 0;
}
public flow model_abort(args: Array<string>) -> i32 {
    let initial = __EMPTY__;
    let result = model_turn_controller("Q", 1, 2, initial) with {
        ModelText.infer(_) => { println("PORT abort model"); abort("D11_EXPECTED_MODEL_ABORT"); }
        ConversationOutput.publish(value) => { resume collect(value); }
    };
    println("UNREACHABLE model abort"); return 0;
}
public flow output_abort(args: Array<string>) -> i32 {
    let initial = __EMPTY__;
    let result = model_turn_controller("Q", 1, 2, initial) with {
        ModelText.infer(_) => { abort("UNEXPECTED model after output abort"); }
        ConversationOutput.publish(_) => { println("PORT abort output"); abort("D11_EXPECTED_OUTPUT_ABORT"); }
    };
    println("UNREACHABLE output abort"); return 0;
}
