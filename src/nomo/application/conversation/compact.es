module nomo.application.conversation.compact;

import std.text.len as text_bytes;
import nomo.application.conversation.ports.{ConversationReader, GenerationReservation, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.execution.service.{begin, dispatching, returned, complete_attempt};
import nomo.application.context.effects.ConversationContext;
import nomo.application.conversation.effects.ConversationModel;
import nomo.application.context.ports.ContextProjection;
import nomo.domain.configuration.settings.{Settings, recent_bytes};

public flow compact<R ~ ConversationReader, G ~ GenerationReservation, A ~ AttemptRepository, P ~ ResultPublication, C ~ ContextProjection>(archive: R, generation: G, attempts: A, publication: P, projection: C, session: string, settings: Settings) -> unit {
    let before = archive.load(session);
    let input = perform ConversationContext.acquire(session, "", settings);
    generation.reserve(session, true, projection.bytes(input));
    var index = before.next_event - 1;
    var first = before.next_event;
    var retained: usize = 0;
    var count: i64 = 0;
    let allowance = recent_bytes(settings);
    @limits([Iterations(2147483647)]) while index >= 0 && count < settings.keep_messages {
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
