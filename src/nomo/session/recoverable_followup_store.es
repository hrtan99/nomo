module nomo.session.recoverable_followup_store;

import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.session.history_work_guard.Record;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// One separately reserved followup slot linked to the current event-chat version.
// The work row and its bounded event batch commit together. Edit intent remains
// a separate durable boundary; if any boundary is uncertain, callers must
// retain the reservation and refuse replay rather than infer an outcome.
public type Frame = { format: i32, policy_binding: string, parent_work_version: string, parent_check_version: string, work: Record, events: EventFrame };

alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;

public let Runs = std.memory.region<Schema>(stable_id = "nomo-recoverable-followup-v1", store = "recoverable-followup");
