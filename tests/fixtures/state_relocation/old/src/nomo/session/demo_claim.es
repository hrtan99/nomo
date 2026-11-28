module nomo.session.demo_claim;



public type Claim = {
    format: i32,
    phase: string,
    session_id: string,
    save_id: string,
    binding: string,
    maximum: i32,
    budget: i32
};

alias Schema = MemoryRegion<{
    Claims: Store<string, Claim>
}>;

public let Demo = std.memory.region<Schema>(stable_id = "nomo-session-demo-v1", store = "session-demo");
