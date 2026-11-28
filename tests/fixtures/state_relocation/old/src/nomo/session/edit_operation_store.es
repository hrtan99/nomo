module nomo.session.edit_operation_store;

import nomo.session.edit_operation.Record;

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Operations = std.memory.region<Schema>(
    stable_id = "nomo-edit-operation-v1",
    store = "edit-operation"
);

public let Followups = std.memory.region<Schema>(stable_id = "nomo-edit-followup-v1", store = "edit-followup");
