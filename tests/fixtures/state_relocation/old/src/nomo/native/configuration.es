module nomo.native.configuration;



public type Cached = {
    digest: bytes,
    session: string,
    result_event: i64
};

alias Schema = MemoryRegion<{
    Parsed: Store<string, Cached>
}>;

public let Data = std.memory.region<Schema>(
    stable_id = "nomo-native-configuration-v1",
    store = "native-configuration"
);
