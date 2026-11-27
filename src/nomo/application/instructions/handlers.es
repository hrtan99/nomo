module nomo.application.instructions.handlers;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.context.ports.InstructionReader;

public flow bindings<G ~ InstructionReader>(guidance: G) -> ![ProjectInstructions => Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] ![] {
    return handler { ProjectInstructions.read(path) => guidance.read(path); };
}
