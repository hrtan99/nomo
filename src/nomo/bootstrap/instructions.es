module nomo.bootstrap.instructions;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.context.ports.InstructionReader;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;

public flow bindings() -> ![ProjectInstructions => Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] ![] {
    let guidance = ProjectInstructionFiles {};
    return handler { ProjectInstructions.read(path) => guidance.read(path); };
}
