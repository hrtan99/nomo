module nomo.domain.conversation.turn;

import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.context.instructions.ProjectInstruction;
import nomo.domain.configuration.settings.Settings;
import nomo.domain.process.jobs.Job;
import nomo.domain.execution.attempt.Attempt;
import nomo.domain.process.archived_jobs.ArchivedJob;

public type Answer = { text: string };
public type Summary = { text: string };
public type Turn = { session: string, workspace: string, initial_request: string, request: string, summary: string, pending: string, history: Array<ChatMessage>, instructions: Array<ProjectInstruction>, runs: Array<Attempt>, settings: Settings, jobs: Array<Job>, archived_jobs: Array<ArchivedJob> };
