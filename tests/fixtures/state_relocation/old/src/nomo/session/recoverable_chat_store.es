module nomo.session.recoverable_chat_store;

import nomo.session.chat_session_contract.Session;
import nomo.session.recoverable_events.Frame as EventFrame;

public type Frame = {
    format: i32,
    encoding: string,
    policy_binding: string,
    chat: Session,
    events: EventFrame
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Frame>
}>;

public let Frames = std.memory.region<Schema>(
    stable_id = "nomo-recoverable-chat-v1",
    store = "recoverable-chat"
);

public type Evidence = {
    format: i32,
    policy_binding: string,
    turn: i32,
    text: string
};

alias EvidenceSchema = MemoryRegion<{
    Rows: Store<string, Evidence>
}>;

public let EvidenceFrames = std.memory.region<EvidenceSchema>(
    stable_id = "nomo-recoverable-chat-evidence-v1",
    store = "recoverable-chat-evidence"
);
