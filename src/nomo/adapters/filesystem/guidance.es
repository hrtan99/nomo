module nomo.adapters.filesystem.guidance;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.domain.context.instructions.ProjectInstruction;
import nomo.application.context.ports.InstructionReader;
import nomo.application.instructions.ports.InstructionFiles;
import nomo.application.instructions.service.load as read_guidance;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;

public type ProjectGuidance = { files: ProjectInstructionFiles };
impl ProjectGuidance ~ InstructionReader {
    flow read(self, path: string) -> Array<ProjectInstruction> ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] {
        return read_guidance(path) with {
            InstructionFiles.normalize(name) => { resume self.files.normalize(name); }
            InstructionFiles.entries(scope) => { resume self.files.entries(scope); }
            InstructionFiles.text(name) => { resume self.files.text(name); }
        };
    }
}
