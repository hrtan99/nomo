module nomo.application.conversation.turn;

import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, GenerationReservation, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.execution.service.{begin, dispatching, returned, complete_attempt};
import nomo.application.context.effects.ConversationContext;
import nomo.application.conversation.effects.{ConversationModel, ConversationOutput};
import nomo.application.context.ports.ContextProjection;
import nomo.domain.configuration.settings.{Settings, effective_window, as_number, estimated_tokens};
import nomo.application.conversation.compact.compact;

public flow ready<R ~ AttemptRepository>(repository: R, session: string) -> bool {
    return match repository.list(session, true).iter().find(value => value.kind == "coding" || value.kind == "summary") {
        Some(value) => {
            perform ConversationOutput.write("[RUN    ] " + value.id + " has no recorded completion. Inspect /runs; /resolve-run ID NOTE records your recovery decision. This prompt was not submitted.");
            false
        }
        None() => true
    };
}

public flow supported(settings: Settings) -> bool {
    if settings.max_output_tokens != 131072 {
        perform ConversationOutput.write("[CONFIG ] This native runtime has a static 131072 output cap. The requested max_output_tokens needs an upstream per-call limit API; no model request was submitted.");
        return false;
    }
    return true;
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
