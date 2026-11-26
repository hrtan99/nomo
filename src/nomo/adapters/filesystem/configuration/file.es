module nomo.adapters.filesystem.configuration.file;

import std.fs.{path, list, relative_name, ReadLimitError, IOError as FileError};
import std.effects.Fs;
import nomo.application.configuration.ports.ConfigurationFile;
import nomo.native.workspace.ProjectRoot;
import nomo.adapters.filesystem.file_io.read_text;

public type ProjectConfigurationFile = {};
impl ProjectConfigurationFile ~ ConfigurationFile {
    flow read(self) -> Option<string> ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] {
        let root = match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => abort("project root unavailable"), };
        var configured = false;
        for item in list(root) { if relative_name(item) == ".nomo.toml" { configured = true; } }
        return if configured { Some(read_text(".nomo.toml")) } else { None() };
    }
}
