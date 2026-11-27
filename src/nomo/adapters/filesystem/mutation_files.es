module nomo.adapters.filesystem.mutation_files;

import nomo.application.commands.effects.CommandOperations;
import std.fs.{path, relative_name, list, atomic_replace, WorkspacePath, ReadLimitError, IOError as FileError};
import std.codec.text.utf8_encode;
import std.effects.Fs;
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.commands.requests.execute_step;
import nomo.adapters.filesystem.file_io.read_text;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.mutations.policy.parent;
import nomo.application.mutations.ports.MutationFileAccess;

flow location(name: string) -> WorkspacePath<ProjectRoot> {
    return match path<ProjectRoot>(name) { Ok(value) => value, Err(_) => abort("invalid project path"), };
}
public type ProjectMutationFiles = {};
impl ProjectMutationFiles ~ MutationFileAccess {
    flow backup(self, id: string) -> string ![] { return "/native-state/edits/" + id; }
    flow normalize(self, name: string) -> string ![] { return relative_name(location(name)); }
    flow exists(self, name: string) -> bool ![Fs.list<ProjectRoot>, Error<FileError>] {
        for item in list(location(parent(name))) {
            if relative_name(item) == name { return true; }
        }
        return false;
    }
    flow read(self, name: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] { return read_text(name); }
    flow replace(self, name: string, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<FileError>] { atomic_replace(location(name), utf8_encode(text)); }
    flow command(self, program: string, arguments: Array<string>, call: i64) -> bool ![SessionContext.current, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
        return execute_step(program, arguments, call).exit_code == 0;
    }
}
