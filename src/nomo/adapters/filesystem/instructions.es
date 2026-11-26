module nomo.adapters.filesystem.instructions;

import std.fs.{path, list, relative_name, ReadLimitError, IOError as FileError};
import std.effects.Fs;
import nomo.application.instructions.ports.InstructionFileSource;
import nomo.native.workspace.ProjectRoot;
import nomo.adapters.filesystem.file_io.read_text;

public type ProjectInstructionFiles = {};
impl ProjectInstructionFiles ~ InstructionFileSource {
    flow normalize(self, pathname: string) -> string ![] {
        let selected = match path<ProjectRoot>(pathname) { Ok(value) => value, Err(_) => abort("invalid project instruction path"), };
        return relative_name(selected);
    }
    flow entries(self, scope: string) -> Array<string> ![Fs.list<ProjectRoot>, Error<FileError>] {
        let selected = match path<ProjectRoot>(scope) { Ok(value) => value, Err(_) => abort("invalid project instruction path"), };
        var result: Array<string> = [];
        for item in list(selected) { result = result.push(relative_name(item)); }
        return result;
    }
    flow text(self, pathname: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] { return read_text(pathname); }
}
