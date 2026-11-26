module nomo.bootstrap.instructions;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.adapters.filesystem.guidance.ProjectGuidance;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;

public flow reader() -> ProjectGuidance { return ProjectGuidance { files = ProjectInstructionFiles {} }; }

public flow bindings() -> ![ProjectInstructions => Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] ![] {
    let guidance = reader();
    return handler { ProjectInstructions.read(path) => { resume guidance.read(path); } };
}
