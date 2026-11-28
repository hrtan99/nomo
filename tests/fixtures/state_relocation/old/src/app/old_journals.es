module app.old_journals;

import nomo.native.lifecycle.Attempt;
import nomo.native.mutations.Data as mutations_Data;
import nomo.native.mutations.Journal;
import nomo.native.mutations.Step;
import std.memory.MemoryCursor;
import std.text.from_i64;

alias Schema = MemoryRegion<{
    Counter: Store<string, i64>,
    Attempts: Store<string, Attempt>
}>;

public let Data = std.memory.region<Schema>(stable_id = "nomo-native-attempts-v1", store = "native-attempts");
