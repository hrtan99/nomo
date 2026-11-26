module nomo.adapters.storage.configuration_cache;

import nomo.application.configuration.ports.ConfigurationCacheStore;
import nomo.domain.configuration.conversion.CacheReference;
import nomo.native.configuration.{Cached, Data};

public type NativeConfigurationCache = {};
impl NativeConfigurationCache ~ ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CacheReference> ![Memory, Error<StorageError>] {
        return match Data.Parsed.get(workspace) {
            Some(value) => Some(CacheReference { digest = value.digest, session = value.session, result_event = value.result_event }),
            None() => None()
        };
    }
    flow remember(self, workspace: string, value: CacheReference) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        Data.Parsed.put(workspace, Cached { digest = value.digest, session = value.session, result_event = value.result_event });
    }
}
