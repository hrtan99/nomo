module nomo.adapters.storage.projects;

import nomo.native.projects.Data;
import nomo.application.projects.ports.RecentProjects;

public type NativeRecentProjects = {};
impl NativeRecentProjects ~ RecentProjects {
    flow load(self) -> Array<string> ![Memory, Error<StorageError>] { return match Data.Recent.get("folders") { Some(value) => value, None() => [] }; }
    flow save(self, folders: Array<string>) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Recent.put("folders", folders); }
}
