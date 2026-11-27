module nomo.application.conversation.terminal_ports;

import std.io.IOError;
import nomo.domain.conversation.commands.Command;
import nomo.domain.conversation.session.Session;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.transfer.copy.CopyJob;
import nomo.domain.execution.attempt.Attempt;
import nomo.domain.execution.command.CommandOutput;
import nomo.domain.execution.checks.CheckOutcome;
import nomo.domain.process.jobs.{Job, JobEvent, InputResult};
import nomo.domain.process.archived_jobs.{ArchivedJob as SavedProjectJob, ArchivedOutput as SavedProjectOutput};
import nomo.domain.workspace.files.FileContent;
import nomo.domain.mutations.models.{Journal, ChangeOutcome};
import nomo.domain.configuration.status.ConfigurationStatus;

public enum TerminalEvent {
    Message(string), Help, Welcome, Project(string), SessionHeader(Session),
    CopyState(CopyJob), Pending(string), UnresolvedAttempt(Attempt),
    History(ChatMessage), MoreHistory(i64), Status(Session), Git(CommandOutput),
    CommandResult(CommandOutput), ProcessJob(Job), JobRead(JobEvent), JobInput(InputResult),
    JobOutput(Array<JobEvent>), ArchivedJob(SavedProjectJob), ArchivedOutput(SavedProjectOutput), Discovery(CommandOutput), File(FileContent),
    Edit(Journal), EditResult(ChangeOutcome), Copy(CopyJob), UnfinishedCopy(CopyJob),
    Run(Attempt), Resolved(Attempt), Config(ConfigurationStatus), Check(CheckOutcome)
}

public spec TerminalInput {
    flow next(self) -> Option<Command> ![Console, Error<IOError>];
}
public spec TerminalDisplay {
    flow show(self, event: TerminalEvent) -> unit ![Console, Error<IOError>];
}
public effect TerminalOutput { action show(event: TerminalEvent) -> unit; }
