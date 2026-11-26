module nomo.application.configuration.ports;

import nomo.application.commands.effects.CommandOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.configuration.settings.Settings;
import nomo.domain.configuration.conversion.{ConfigurationOutput, Converted, CacheReference};

public effect ConfigurationSource { action read() -> Option<string>; }
public effect ConfigurationCodec {
    action fingerprint(raw: string) -> bytes;
    action decode_json(text: string) -> Settings;
    action observation(text: string) -> ConfigurationOutput;
}
public effect ConfigurationConversion {
    action toml(raw: string) -> Converted;
    action entries(json: string) -> Converted;
}
public effect ConfigurationCache {
    action lookup(workspace: string) -> Option<CacheReference>;
    action remember(workspace: string, value: CacheReference) -> unit;
}

public spec ConfigurationFile {
    flow read(self) -> Option<string> ![Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
}
public spec EntriesCodec {
    flow fingerprint(self, raw: string) -> bytes ![];
    flow decode_json(self, text: string) -> Settings ![];
    flow observation(self, text: string) -> ConfigurationOutput ![];
}
public spec TomlConverter {
    flow toml(self, raw: string) -> Converted ![SessionContext, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>];
    flow entries(self, json: string) -> Converted ![SessionContext, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>];
}
public spec ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CacheReference> ![Memory, Error<StorageError>];
    flow remember(self, workspace: string, value: CacheReference) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}
