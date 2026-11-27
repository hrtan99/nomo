module nomo.adapters.storage.configuration_cache;

import nomo.application.configuration.ports.ConfigurationCacheStore;
import nomo.domain.configuration.conversion.CacheReference;
import nomo.native.configuration.Data;

public type NativeConfigurationCache = {};
impl NativeConfigurationCache ~ ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CacheReference> ![Memory, Error<StorageError>] {
        return Data.Parsed.get(workspace);
    }
    flow remember(self, workspace: string, value: CacheReference) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        Data.Parsed.put(workspace, value);
    }
}
