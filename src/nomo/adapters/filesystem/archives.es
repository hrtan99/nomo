module nomo.adapters.filesystem.archives;

import std.fs.{path, read_bytes_limited, atomic_replace, WorkspacePath, ReadLimitError, IOError as FileError};
import std.codec.text.{utf8_decode, utf8_encode, Strict};
import std.effects.Fs;
import nomo.native.workspace.ProjectRoot;
import nomo.application.transfer.ports.ArchiveWorkspace;

public type ProjectArchives = {};
impl ProjectArchives ~ ArchiveWorkspace {
    flow target(self, pathname: string) -> WorkspacePath<ProjectRoot> ![] {
        return match path<ProjectRoot>(pathname) { Ok(value) => value, Err(_) => abort("invalid conversation export path"), };
    }
    flow read(self, pathname: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] {
        let location = match path<ProjectRoot>(pathname) { Ok(value) => value, Err(_) => abort("invalid conversation import path"), };
        return match utf8_decode(read_bytes_limited(location, 536870912), Strict) { Ok(value) => value, Err(_) => abort("conversation archive must be UTF-8"), };
    }
    flow replace(self, target: WorkspacePath<ProjectRoot>, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<FileError>] { atomic_replace(target, utf8_encode(text)); }
}
