module nomo.domain.sessions.edit_operation_store;

import std.memory.MemoryVersion;
import nomo.session.edit_operation.Binding;

public type Ticket = { binding: Binding, version: MemoryVersion };
