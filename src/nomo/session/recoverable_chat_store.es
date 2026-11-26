module nomo.session.recoverable_chat_store;

import nomo.session.chat_session_contract.Session;
import nomo.session.recoverable_events.Frame as EventFrame;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// The opt-in read-only path joins the chat reservation and filtered event batch
// in one CAS record. Each access must supply the same bound trusted policy.
// Known-literal filtering is not comprehensive secret detection; the record
// does not establish workspace identity, grant authority, or support work/check.
public type Frame = { format: i32, encoding: string, policy_binding: string, chat: Session, events: EventFrame };

alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;

public let Frames = std.memory.region<Schema>(stable_id = "nomo-recoverable-chat-v1", store = "recoverable-chat");

// A chat frame keeps the latest selected outcome in Invocation.prior. Before a
// later turn replaces it, archive that outcome under its completed turn. This
// avoids accumulating repeated large values in the 1 MiB frame while keeping
// every completed selected result recoverable.
public type Evidence = { format: i32, policy_binding: string, turn: i32, text: string };

alias EvidenceSchema = MemoryRegion<{ Rows: Store<string, Evidence> }>;

public let EvidenceFrames = std.memory.region<EvidenceSchema>(stable_id = "nomo-recoverable-chat-evidence-v1", store = "recoverable-chat-evidence");
