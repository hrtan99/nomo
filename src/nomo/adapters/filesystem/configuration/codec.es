module nomo.adapters.filesystem.configuration.codec;

import nomo.application.configuration.ports.EntriesCodec;
import nomo.domain.configuration.settings.Settings;
import nomo.domain.configuration.conversion.ConfigurationOutput;
import nomo.adapters.storage.codec.configuration.{fingerprint, decode, observation};

public type JsonConfigurationCodec = {};
impl JsonConfigurationCodec ~ EntriesCodec {
    flow fingerprint(self, raw: string) -> bytes ![] { return fingerprint(raw); }
    flow decode_json(self, text: string) -> Settings ![] { return decode(text); }
    flow observation(self, text: string) -> ConfigurationOutput ![] { return observation(text); }
}
