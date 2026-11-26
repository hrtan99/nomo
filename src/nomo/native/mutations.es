module nomo.native.mutations;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
public type Journal = { id: string, session: string, name: string, call: i64, phase: string, steps: i64, message: string, owner_call: i64, owner_name: string };

public type SavedPath = { path: string, before_exists: bool, before: string, after_exists: bool, after: string };

public type Step = { phase: string, paths: Array<SavedPath> };

alias Schema = MemoryRegion<{ Journals: Store<string, Journal>, Steps: Store<string, Step> }>;

public let Data = std.memory.region<Schema>(stable_id = "nomo-native-file-journals-v1", store = "native-file-journals");
