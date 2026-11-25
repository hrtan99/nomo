module nomo.application.native.conversation.controller;

import std.text.len as text_bytes;
import nomo.application.native.conversation.ports.{ConversationReader, ConversationWriter, GenerationReservation, ResultPublication};
import nomo.application.native.execution.ports.AttemptRepository;
import nomo.application.native.execution.service.{begin, dispatching, returned, complete_attempt};
import nomo.application.native.context.effects.ConversationContext;
import nomo.application.native.conversation.model.{ConversationModel, ConversationOutput};
import nomo.domain.context.projection.ContextProjection;
import nomo.domain.configuration.settings.{Settings, effective_window, as_number, estimated_tokens, recent_bytes};

public flow ready<R ~ AttemptRepository>(repository: R, session: string) -> bool {
    for value in repository.list(session, true) limit Iterations(2147483647) {
        if value.kind == "coding" || value.kind == "summary" {
            perform ConversationOutput.write("[RUN    ] " + value.id + " has no recorded completion. Inspect /runs; /resolve-run ID NOTE records your recovery decision. This prompt was not submitted.");
            return false;
        }
    }
    return true;
}

public flow supported(settings: Settings) -> bool {
    if settings.max_output_tokens != 131072 {
        perform ConversationOutput.write("[CONFIG ] This native runtime has a static 131072 output cap. The requested max_output_tokens needs an upstream per-call limit API; no model request was submitted.");
        return false;
    }
    return true;
}

public flow compact<R ~ ConversationReader, G ~ GenerationReservation, A ~ AttemptRepository, P ~ ResultPublication, C ~ ContextProjection>(archive: R, generation: G, attempts: A, publication: P, projection: C, session: string, settings: Settings) -> unit {
    let before = archive.load(session);
    let input = perform ConversationContext.acquire(session, "", settings);
    generation.reserve(session, true, projection.bytes(input));
    var index = before.next_event - 1;
    var first = before.next_event;
    var retained: usize = 0;
    var count: i64 = 0;
    let allowance = recent_bytes(settings);
    while index >= 0 && count < settings.keep_messages limit Iterations(2147483647) {
        let bytes = text_bytes(archive.message(session, index).text);
        if bytes > allowance - retained { break; }
        retained = retained + bytes;
        first = index;
        count = count + 1;
        index = index - 1;
    }
    let through = first - 1;
    let attempt = begin(attempts, session, "summary", "CompactHistory", before.next_event - 1, through);
    dispatching(attempts, attempt.id);
    let summary = perform ConversationModel.summarize(input);
    returned(attempts, publication, attempt.id, "summary", "context_summary", summary.text, -1);
    complete_attempt(attempts, publication, archive, attempt.id);
}

public flow turn<R ~ ConversationReader, W ~ ConversationWriter, G ~ GenerationReservation, A ~ AttemptRepository, P ~ ResultPublication, C ~ ContextProjection>(archive: R, writer: W, generation: G, attempts: A, publication: P, projection: C, session: string, request: string) -> bool {
    if !ready(attempts, session) { return false; }
    let request_event = writer.append(session, "user", "", request, -1);
    let settings = perform ConversationContext.settings(session);
    if !supported(settings) { return false; }
    var input = perform ConversationContext.acquire(session, request, settings);
    if projection.needs_compaction(input) {
        perform ConversationOutput.write("[CONTEXT] Summarizing; complete original history stays saved.");
        compact(archive, generation, attempts, publication, projection, session, settings);
        input = perform ConversationContext.acquire(session, request, settings);
    }
    if estimated_tokens(projection.bytes(input)) > as_number(effective_window(settings) - settings.max_output_tokens) {
        perform ConversationOutput.write("[CONTEXT] Saved summary and retained input still exceed the configured context estimate. No coding model request was submitted; complete original history remains saved.");
        return false;
    }
    generation.reserve(session, false, projection.bytes(input));
    let attempt = begin(attempts, session, "coding", "NativeCoding", request_event, archive.load(session).next_event - 1);
    dispatching(attempts, attempt.id);
    let answer = perform ConversationModel.code(input);
    returned(attempts, publication, attempt.id, "assistant", "", answer.text, request_event);
    complete_attempt(attempts, publication, archive, attempt.id);
    perform ConversationOutput.write(answer.text);
    return true;
}
