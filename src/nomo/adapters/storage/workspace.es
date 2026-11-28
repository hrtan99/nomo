module nomo.adapters.storage.workspace;

import nomo.application.workspace.ports.{ConfigurationCacheStore, RecentProjects};
import nomo.domain.settings.CachedConfiguration;

public type NativeConfigurationCache = {};

impl NativeConfigurationCache ~ ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CachedConfiguration> ![Memory, Error<StorageError>] {
        return ConfigurationCache.Parsed.get(workspace);
    }

    flow remember(self, workspace: string, value: CachedConfiguration) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        ConfigurationCache.Parsed.put(workspace, value);
    }
}

public type NativeRecentProjects = {};

impl NativeRecentProjects ~ RecentProjects {
    flow load(self) -> Array<string> ![Memory, Error<StorageError>] {
        return match Projects.Recent.get("folders") {
            Some(value) => value,
            None() => []
        };
    }

    flow save(self, folders: Array<string>) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        Projects.Recent.put("folders", folders);
    }
}

alias ConfigurationCacheSchema = MemoryRegion<{
    Parsed: Store<string, CachedConfiguration>
}>;

public let ConfigurationCache = std.memory.region<ConfigurationCacheSchema>(
    stable_id = "nomo-native-configuration-v1",
    store = "native-configuration"
);

alias ProjectsSchema = MemoryRegion<{
    Recent: Store<string, Array<string>>
}>;

public let Projects = std.memory.region<ProjectsSchema>(
    stable_id = "nomo-native-projects-v1",
    store = "native-projects"
);
