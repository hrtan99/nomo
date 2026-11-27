module nomo.bootstrap.configuration;

import nomo.application.configuration.service.ConfigurationLoader;
import nomo.application.conversation.ports.ConversationReader;
import nomo.adapters.filesystem.configuration.file.ProjectConfigurationFile;
import nomo.adapters.filesystem.configuration.codec.JsonConfigurationCodec;
import nomo.adapters.filesystem.configuration.converter.TaploConfigurationConverter;
import nomo.adapters.storage.configuration_cache.NativeConfigurationCache;

public alias ConfiguredConfiguration<H ~ ConversationReader> = ConfigurationLoader<H, ProjectConfigurationFile, JsonConfigurationCodec, TaploConfigurationConverter, NativeConfigurationCache>;

public flow create<H ~ ConversationReader>(history: H) -> ConfiguredConfiguration<H> {
    return ConfiguredConfiguration<H> {
        history,
        source = ProjectConfigurationFile {},
        codec = JsonConfigurationCodec {},
        converter = TaploConfigurationConverter {},
        cache = NativeConfigurationCache {},
    };
}
