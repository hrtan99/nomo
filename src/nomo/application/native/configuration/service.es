module nomo.application.native.configuration.service;

import std.crypto.constant_time_eq;
import nomo.application.native.configuration.ports.{ConfigurationSource, ConfigurationCodec, ConfigurationConversion, ConfigurationCache};
import nomo.application.native.conversation.ports.ConversationReader;
import nomo.domain.configuration.settings.{Settings, defaults};
import nomo.domain.configuration.conversion.CacheReference;
import nomo.native.history.SessionContext;

public flow load<R ~ ConversationReader>(history: R) -> Settings {
    let raw = match perform ConfigurationSource.read() { Some(value) => value, None() => { return defaults(); } };
    let digest = perform ConfigurationCodec.fingerprint(raw);
    let session = perform SessionContext.current();
    let workspace = history.load(session).workspace;
    match perform ConfigurationCache.lookup(workspace) {
        Some(cached) => {
            if constant_time_eq(cached.digest, digest) {
                let observation = perform ConfigurationCodec.observation(history.message(cached.session, cached.result_event).text);
                return perform ConfigurationCodec.decode_json(observation.stdout);
            }
        }
        None() => {}
    }
    let observation = perform ConfigurationConversion.toml(raw);
    if observation.output.exit_code != 0 { abort("project configuration TOML conversion failed: " + observation.output.stderr); }
    let converted = perform ConfigurationConversion.entries(observation.output.stdout);
    if converted.output.exit_code != 0 { abort("configuration entry conversion failed: " + converted.output.stderr); }
    let settings = perform ConfigurationCodec.decode_json(converted.output.stdout);
    perform ConfigurationCache.remember(workspace, CacheReference { digest = digest, session = session, result_event = converted.result_event });
    return settings;
}
