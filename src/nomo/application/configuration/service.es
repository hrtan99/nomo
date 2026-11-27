module nomo.application.configuration.service;

import std.crypto.constant_time_eq;
import nomo.application.commands.effects.CommandOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.configuration.ports.{ConfigurationFile, EntriesCodec, TomlConverter, ConfigurationCacheStore};
import nomo.application.conversation.service_ports.ConversationConfiguration;
import nomo.application.conversation.ports.ConversationReader;
import nomo.domain.configuration.settings.{Settings, defaults};
import nomo.domain.configuration.conversion.CacheReference;

public type ConfigurationLoader<History ~ ConversationReader, Source ~ ConfigurationFile, Codec ~ EntriesCodec,
    Converter ~ TomlConverter, Cache ~ ConfigurationCacheStore> = {
    @inject history: History,
    @inject source: Source,
    @inject codec: Codec,
    @inject converter: Converter,
    @inject cache: Cache,
};

impl ConfigurationLoader<History ~ ConversationReader, Source ~ ConfigurationFile, Codec ~ EntriesCodec,
    Converter ~ TomlConverter, Cache ~ ConfigurationCacheStore> ~ ConversationConfiguration {
    flow load(self, session: string) -> Settings
        ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>] {
        let raw = match self.source.read() { Some(value) => value, None() => { return defaults(); } };
        let digest = self.codec.fingerprint(raw);
        let workspace = self.history.load(session).workspace;
        match self.cache.lookup(workspace) {
            Some(cached) => {
                if constant_time_eq(cached.digest, digest) {
                    let observation = self.codec.observation(self.history.message(cached.session, cached.result_event).text);
                    return self.codec.decode_json(observation.stdout);
                }
            },
            None() => (),
        }
        let observation = self.converter.toml(session, raw);
        if observation.output.exit_code != 0 { abort("project configuration TOML conversion failed: " + observation.output.stderr); }
        let converted = self.converter.entries(session, observation.output.stdout);
        if converted.output.exit_code != 0 { abort("configuration entry conversion failed: " + converted.output.stderr); }
        let settings = self.codec.decode_json(converted.output.stdout);
        self.cache.remember(workspace, CacheReference { digest, session, result_event = converted.result_event });
        return settings;
    }
}
