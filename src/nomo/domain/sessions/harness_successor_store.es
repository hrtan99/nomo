module nomo.domain.sessions.harness_successor_store;

import std.memory.MemoryVersion;
import nomo.session.harness_checkpoint.Identity;
import nomo.domain.sessions.harness_checkpoint_store.Binding;

public type Ticket = { predecessor: Binding, successor: Identity, request: string, version: MemoryVersion };
