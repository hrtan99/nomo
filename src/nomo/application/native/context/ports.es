module nomo.application.native.context.ports;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.domain.context.instructions.ProjectInstruction;
import nomo.domain.process.jobs.Job;

public spec InstructionReader {
    flow read(self, path: string) -> Array<ProjectInstruction> ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
}

public spec SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>];
}
