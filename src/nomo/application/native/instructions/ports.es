module nomo.application.native.instructions.ports;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;

public effect InstructionFiles {
    action normalize(path: string) -> string;
    action entries(scope: string) -> Array<string>;
    action text(path: string) -> string;
}

public spec InstructionFileSource {
    flow normalize(self, path: string) -> string ![];
    flow entries(self, scope: string) -> Array<string> ![Fs.list<ProjectRoot>, Error<FileError>];
    flow text(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
}
