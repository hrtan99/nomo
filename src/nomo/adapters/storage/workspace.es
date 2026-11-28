module nomo.adapters.storage.workspace;

import nomo.application.workspace.ports.{ConfigurationCacheStore, RecentProjects};
import nomo.native.configuration.{Cached, Data};
import nomo.native.projects.Data as projects_Data;

public type NativeConfigurationCache = {};

impl NativeConfigurationCache ~ ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<Cached> ![Memory, Error<StorageError>] {
        return Data.Parsed.get(workspace);
    }
    flow remember(self, workspace: string, value: Cached) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        Data.Parsed.put(workspace, value);
    }
}

public type NativeRecentProjects = {};

impl NativeRecentProjects ~ RecentProjects {
    flow load(self) -> Array<string> ![Memory, Error<StorageError>] { return match projects_Data.Recent.get("folders") { Some(value) => value, None() => [] }; }
    flow save(self, folders: Array<string>) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { projects_Data.Recent.put("folders", folders); }
}
