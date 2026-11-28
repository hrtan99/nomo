module nomo.domain.sessions.user_context_chain_v4_store;

import nomo.domain.sessions.user_context_chain_v4.Record;
import std.memory.{MemoryEntry, MemoryVersion};

// Storage tickets are not root-identity authority or permission to execute.
// No production entry or RootObservation handler is supplied by this module.
public type Ticket = {
    row: Record,
    version: MemoryVersion,
    parent: Option<MemoryEntry<string, Record>>
};
