module nomo.bootstrap.configuration;

import nomo.application.commands.effects.CommandOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.configuration.settings.Settings;
import nomo.application.configuration.ports.{ConfigurationSource, ConfigurationCodec, ConfigurationConversion, ConfigurationCache};
import nomo.application.configuration.service.load as load_configuration;
import nomo.adapters.filesystem.configuration.file.ProjectConfigurationFile;
import nomo.adapters.filesystem.configuration.codec.JsonConfigurationCodec;
import nomo.adapters.filesystem.configuration.converter.TaploConfigurationConverter;
import nomo.adapters.storage.configuration_cache.NativeConfigurationCache;
import nomo.adapters.storage.conversations.NativeHistory;

public flow load() -> Settings ![SessionContext, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>] {
    let source = ProjectConfigurationFile {};
    let codec = JsonConfigurationCodec {};
    let conversion = TaploConfigurationConverter {};
    let cache = NativeConfigurationCache {};
    return load_configuration(NativeHistory {}) with {
        ConfigurationSource.read() => { resume source.read(); }
        ConfigurationCodec.fingerprint(raw) => { resume codec.fingerprint(raw); }
        ConfigurationCodec.decode_json(text) => { resume codec.decode_json(text); }
        ConfigurationCodec.observation(text) => { resume codec.observation(text); }
        ConfigurationConversion.toml(raw) => { resume conversion.toml(raw); }
        ConfigurationConversion.entries(json) => { resume conversion.entries(json); }
        ConfigurationCache.lookup(workspace) => { resume cache.lookup(workspace); }
        ConfigurationCache.remember(workspace, value) => { cache.remember(workspace, value); resume; }
    };
}
