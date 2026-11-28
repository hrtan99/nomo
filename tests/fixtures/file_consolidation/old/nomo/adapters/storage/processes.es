module nomo.adapters.storage.processes;

import nomo.domain.process.archived_jobs.ArchivedJob;

alias ArchivedSchema = MemoryRegion<{ Jobs: Store<string, ArchivedJob>, Parts: Store<string, bytes> }>;
public let ArchivedJobs = std.memory.region<ArchivedSchema>(stable_id = "nomo-native-project-jobs-v1", store = "native-project-jobs");
