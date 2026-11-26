module nomo.domain.sessions.work_chain_store;

import std.memory.{MemoryVersion, MemoryEntry};
import nomo.session.work_chain.Record;

public type Ticket = { row: Record, version: MemoryVersion, parent: Option<MemoryEntry<string, Record>> };

public enum ParentAccess { Found(MemoryEntry<string, Record>), Refused(string), UserContext }
