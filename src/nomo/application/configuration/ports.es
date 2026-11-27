module nomo.application.configuration.ports;

import nomo.application.commands.effects.CommandOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.configuration.settings.Settings;
import nomo.domain.configuration.conversion.{ConfigurationOutput, Converted, CacheReference};

public spec ConfigurationFile {
    flow read(self) -> Option<string> ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
}
public spec EntriesCodec {
    flow fingerprint(self, raw: string) -> bytes ![];
    flow decode_json(self, text: string) -> Settings ![];
    flow observation(self, text: string) -> ConfigurationOutput ![];
}
public spec TomlConverter {
    flow toml(self, session: string, raw: string) -> Converted ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<BudgetExceeded>];
    flow entries(self, session: string, json: string) -> Converted ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<BudgetExceeded>];
}
public spec ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CacheReference> ![Memory, Error<StorageError>];
    flow remember(self, workspace: string, value: CacheReference) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}
