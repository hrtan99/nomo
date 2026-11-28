module nomo.native.projects;

import std.fs.Region;

alias Schema = MemoryRegion<{
    Recent: Store<string, Array<string>>
}>;

public let Data = std.memory.region<Schema>(stable_id = "nomo-native-projects-v1", store = "native-projects");
