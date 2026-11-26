module nomo.session.continuous_work;

import nomo.core.conversation.Event;
import nomo.session.edit_operation.Binding;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// All additional rounds share one append-only history and one current slot.
// Each current edit/check transition is durable before its external effect.
public type Core = { id: string, request: string };

public type Edit = { phase: string, binding: Option<Binding> };

public type ResultData = { phase: string, summary: string, source: string, calls: i32, generation: i32, events: Array<Event> };

public type Check = { phase: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };

public type Entry = { core: Core, edit: Edit, result: ResultData, check: Check };

public type Book = { binding: string, history: Array<Entry>, current: Entry };

alias Schema = MemoryRegion<{ Rows: Store<string, Book> }>;

public let Books = std.memory.region<Schema>(stable_id = "nomo-continuous-work-v1", store = "continuous-work");
