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
import nomo.application.conversation.ports.ConversationReader;

public flow load<R ~ ConversationReader>(history: R, session: string) -> Settings ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>] {
    let source = ProjectConfigurationFile {};
    let codec = JsonConfigurationCodec {};
    let conversion = TaploConfigurationConverter {};
    let cache = NativeConfigurationCache {};
    return handle (load_configuration(history) with {
        ConfigurationSource.read() => source.read();
        ConfigurationCodec.fingerprint(raw) => codec.fingerprint(raw);
        ConfigurationCodec.decode_json(text) => codec.decode_json(text);
        ConfigurationCodec.observation(text) => codec.observation(text);
        ConfigurationConversion.toml(raw) => conversion.toml(raw);
        ConfigurationConversion.entries(json) => conversion.entries(json);
        ConfigurationCache.lookup(workspace) => cache.lookup(workspace);
        ConfigurationCache.remember(workspace, value) => cache.remember(workspace, value);
    }) with { SessionContext.current() => session; };
}
