module app.old_conversations;

import nomo.native.history.CopyJob;
import nomo.native.history.Event;
import nomo.native.history.Ledger;
import nomo.native.history.Session;
import std.json.JsonValue;
import std.memory.MemoryCursor;
import std.memory.MemoryEntry;
import std.text.TextBuilder;
import std.text.char_count;
import std.text.from_i64;
import std.text.from_usize;
import std.text.get_char_slice;
import std.text.parse_i64;
import std.text.split_once;
import std.text.strip_prefix;

alias Schema = MemoryRegion<
    {
        Counters: Store<string, i64>,
        Selected: Store<string, string>,
        Sessions: Store<string, Session>,
        Events: Store<string, Event>,
        Chunks: Store<string, string>,
    }
>;

public let Data = std.memory.region<Schema>(
    stable_id = "nomo-native-conversations-v1",
    store = "native-conversations"
);

alias CopySchema = MemoryRegion<{
    Jobs: Store<string, CopyJob>
}>;

public let Copies = std.memory.region<CopySchema>(
    stable_id = "nomo-native-conversation-copies-v1",
    store = "native-conversation-copies"
);
