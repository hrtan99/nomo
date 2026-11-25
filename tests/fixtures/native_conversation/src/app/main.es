module app.main;

import std.io.{println, IOError};
import std.text.from_i64;
import nomo.adapters.etas.conversations.NativeHistory;
import nomo.adapters.etas.attempts.NativeAttempts;
import nomo.application.native.conversation.ports.{ConversationReader, ConversationWriter, ConversationCatalog, GenerationReservation, ResultPublication};
import nomo.application.native.execution.ports.AttemptRepository;
import nomo.application.native.conversation.controller.turn;
import nomo.application.native.conversation.model.{ConversationModel, ConversationOutput};
import nomo.application.native.context.effects.ConversationContext;
import nomo.domain.context.projection.{ContextProjection, RollingContext, project};
import nomo.domain.configuration.settings.Settings;
import nomo.domain.conversation.turn.{Turn, Answer, Summary};

flow settings() -> Settings {
    return Settings { context_window = 262144, max_output_tokens = 131072, compact_ratio = 0.001,
        keep_messages = 0, command_timeout = 600, ignore = [], instructions = [], check = [] };
}

flow context(history: NativeHistory, attempts: NativeAttempts, session: string, request: string, configuration: Settings) -> Turn {
    let selected = history.load(session);
    let initial = history.message(session, selected.first_user).text;
    let summary = if selected.summary_event >= 0 { history.message(session, selected.summary_event).text } else { "" };
    println("PORT context " + from_i64(selected.next_event));
    return project(Turn { session = session, workspace = selected.workspace, initial_request = initial, request = request,
        summary = summary, pending = selected.pending, history = history.messages(session, selected.summary_through + 1),
        instructions = [], runs = attempts.list(session, true), settings = configuration, jobs = [] });
}

flow dispatched(history: NativeHistory, attempts: NativeAttempts, session: string, kind: string, allowance: i64) -> unit {
    let outstanding = attempts.list(session, true);
    if outstanding.len() != 1 || outstanding[0].kind != kind || outstanding[0].phase != "dispatching" || outstanding[0].result_event != -1 {
        abort("model started without exactly one durable dispatching attempt");
    }
    let value = history.load(session);
    if value.ledger.generation_allowance != allowance || value.ledger.compactions != 1 {
        abort("model started before its generation reservation");
    }
    if kind == "summary" && value.summary_event != -1 { abort("summary was selected before it was generated"); }
    if kind == "coding" && (value.summary_event != 1 || value.summary_through != 0 || value.ledger.turns != 1) {
        abort("coding started before summary publication and selection");
    }
    println("PORT " + kind + " dispatching");
}

public flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let history = NativeHistory {};
    let attempts = NativeAttempts {};
    let saved = history.create("controller-workspace", "Controlled conversation");
    var request = "";
    var index: i32 = 0;
    while index < 32 limit Iterations(32) { request = request + "Continue the same coding objective. "; index = index + 1; }
    let accepted = turn(history, history, history, attempts, history, RollingContext {}, saved.id, request) with {
        ConversationContext.settings(session) => {
            if session != saved.id || history.load(session).next_event != 1 { abort("settings were not loaded after the user append"); }
            println("PORT settings");
            resume settings();
        }
        ConversationContext.acquire(session, task, configuration) => {
            resume context(history, attempts, session, task, configuration);
        }
        ConversationModel.summarize(input) => {
            dispatched(history, attempts, saved.id, "summary", 32768);
            if input.request != "" || input.initial_request != request || input.history.len() != 1 || input.history[0].text != request {
                abort("summary did not receive complete original context");
            }
            resume Summary { text = "A compact summary" };
        }
        ConversationModel.code(input) => {
            dispatched(history, attempts, saved.id, "coding", 163840);
            if input.request != request || input.initial_request != request || input.summary != "A compact summary" || input.history.len() != 0 {
                abort("coding did not receive the rebuilt summarized context");
            }
            resume Answer { text = "Completed deterministic turn" };
        }
        ConversationOutput.write(line) => { println("OUTPUT " + line); resume; }
    };
    let selected = history.load(saved.id);
    if !accepted || selected.next_event != 3 || selected.first_user != 0 || selected.summary_event != 1 || selected.summary_through != 0 {
        abort("conversation event ordering changed");
    }
    if history.message(saved.id, 0).text != request || history.message(saved.id, 1).text != "A compact summary" || history.message(saved.id, 2).text != "Completed deterministic turn" {
        abort("complete original, summary or answer was not retained");
    }
    let completed = attempts.list(saved.id, false);
    if completed.len() != 2 || attempts.list(saved.id, true).len() != 0 { abort("completed attempts were not settled"); }
    for value in completed limit Iterations(2) {
        if value.phase != "completed" || value.input_event != 0 { abort("attempt completion ordering changed"); }
        if value.kind == "summary" && (value.result_event != 1 || value.through != 0) { abort("summary attempt points to the wrong history slot"); }
        if value.kind == "coding" && (value.result_event != 2 || value.through != 1) { abort("coding attempt points to the wrong history slot"); }
    }
    println("PASS deterministic conversation with compaction");
    return 0;
}
