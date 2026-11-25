module nomo.application.native.context.acquire;

import nomo.application.native.conversation.ports.ConversationReader;
import nomo.application.native.execution.ports.AttemptRepository;
import nomo.application.native.context.ports.{InstructionReader, SavedJobsReader};
import nomo.domain.conversation.turn.Turn;
import nomo.domain.configuration.settings.Settings;
import nomo.domain.context.projection.project;

public flow build<R ~ ConversationReader, I ~ InstructionReader, A ~ AttemptRepository, J ~ SavedJobsReader>(history: R, instructions: I, attempts: A, jobs: J, session: string, request: string, settings: Settings) -> Turn {
    let value = history.load(session);
    let initial = if value.first_user >= 0 { history.message(session, value.first_user).text } else { request };
    let summary = if value.summary_event >= 0 { history.message(session, value.summary_event).text } else { "" };
    let messages = history.messages(session, value.summary_through + 1);
    let guidance = instructions.read(".");
    let unresolved = attempts.list(session, true);
    let saved_jobs = jobs.read(session);
    return project(Turn { session = session, workspace = value.workspace, initial_request = initial,
        request = request, summary = summary, pending = value.pending, history = messages,
        instructions = guidance, runs = unresolved, settings = settings, jobs = saved_jobs });
}
