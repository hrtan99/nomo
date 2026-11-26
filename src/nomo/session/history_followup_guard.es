module nomo.session.history_followup_guard;

import nomo.session.history_work_guard.Record as WorkRecord;
import nomo.session.history_check_store.Record as CheckRecord;
import nomo.session.edit_operation.Record as EditRecord;
import nomo.harness.harness_work_contract.Ledger;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// One additional work attempt, with separate reserved budget and fresh grants.
// The predecessor is untrusted recorded context, not a current root witness.
public type Budget = { steps: i32, calls: i32, generation: i32, native_tokens: i32 };

public type Parent = { work: WorkRecord, edit: EditRecord, check: Option<CheckRecord> };

public type Record = { format: i32, phase: string, id: string, workspace: string, path: string, request: string,
    history_version: string, parent: Parent, reserved: Budget, settled: Option<Ledger>, summary: string };

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;

public let Runs = std.memory.region<Schema>(stable_id = "nomo-history-followup-v1", store = "history-followup");
