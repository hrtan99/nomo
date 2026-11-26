module nomo.application.context.ports;

import nomo.domain.conversation.turn.Turn;
import nomo.domain.context.instructions.ProjectInstruction;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.domain.process.jobs.Job;

public spec ContextProjection {
    flow bytes(self, input: Turn) -> usize ![];
    flow needs_compaction(self, input: Turn) -> bool ![];
}

public spec InstructionReader {
    flow read(self, path: string) -> Array<ProjectInstruction> ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
}

public spec SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}
