module nomo.application.context.acquire;

import nomo.application.conversation.ports.ConversationReader;
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.context.ports.{InstructionReader, SavedJobsReader};
import nomo.application.processes.ports.ArchivedJobCatalog;
import nomo.domain.conversation.turn.Turn;
import nomo.domain.configuration.settings.Settings;
import nomo.domain.context.projection.project;

public flow build<R ~ ConversationReader, I ~ InstructionReader, A ~ AttemptRepository, J ~ SavedJobsReader + ArchivedJobCatalog>(history: R, instructions: I, attempts: A, jobs: J, session: string, request: string, settings: Settings) -> Turn {
    let value = history.load(session);
    let initial = if value.first_user >= 0 { history.message(session, value.first_user).text } else { request };
    let summary = if value.summary_event >= 0 { history.message(session, value.summary_event).text } else { "" };
    let messages = history.messages(session, value.summary_through + 1);
    let guidance = instructions.read(".");
    let unresolved = attempts.list(session, true);
    let saved_jobs = jobs.read(session);
    return project(Turn { session, workspace = value.workspace, initial_request = initial,
        request, summary, pending = value.pending, history = messages,
        instructions = guidance, runs = unresolved, settings, jobs = saved_jobs, archived_jobs = jobs.archived_jobs(value.workspace) });
}
