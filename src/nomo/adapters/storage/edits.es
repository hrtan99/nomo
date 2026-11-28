module nomo.adapters.storage.edits;

import nomo.adapters.storage.session_records.submit_native;
import nomo.application.editing.ports.Ticket as ports_Ticket;
import nomo.application.sessions.admission.{available, begin, complete, edit_operations_inspect};
import nomo.application.sessions.persistence.commit_once;
import nomo.application.sessions.ports.{CasRows, EditJournal, Submission, Target};
import nomo.domain.editing.{Selector, same_binding, same_record, selector_error};
import nomo.domain.sessions.work.{confirm, same_record as work_same_record, validate};
import nomo.session.edit_operation.{Binding, Record};
import nomo.session.edit_operation_store.{Followups, Operations};
import nomo.session.work_record.Record as work_record_Record;
import nomo.session.work_record_store.Work;
import std.memory.{MemoryEntry, MemoryVersion, Missing, WriteCondition};

public type FirstEditJournal = {};

public type FollowupEditJournal = {};

impl FirstEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-edit-operation-v1",
            key = "operation",
            label = "edit journal"
        };
    }

    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
        return submit_native(Operations.Rows, "operation", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> {
        return Ok(Operations.Rows.get_entry("operation"));
    }

    flow same(self, left: Record, right: Record) -> bool ![] {
        return same_record(left, right);
    }
}

impl FirstEditJournal ~ EditJournal {
    flow available(self) -> Result<bool, string> {
        return available(self);
    }

    flow begin(self, binding: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return begin(self, binding);
    }

    flow complete(self, ticket: ports_Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return complete(self, ticket);
    }

    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> {
        return edit_operations_inspect(self, selector);
    }
}

impl FollowupEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-edit-followup-v1",
            key = "operation",
            label = "edit journal"
        };
    }

    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] {
        return submit_native(Followups.Rows, "operation", value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> {
        return Ok(Followups.Rows.get_entry("operation"));
    }

    flow same(self, left: Record, right: Record) -> bool ![] {
        return same_record(left, right);
    }
}

impl FollowupEditJournal ~ EditJournal {
    flow available(self) -> Result<bool, string> {
        return available(self);
    }

    flow begin(self, binding: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return begin(self, binding);
    }

    flow complete(self, ticket: ports_Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        return complete(self, ticket);
    }

    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> {
        return edit_operations_inspect(self, selector);
    }
}

public flow edit_operation_store_available() -> Result<bool, string> {
    let journal = FirstEditJournal {};
    return journal.available();
}

public flow edit_operation_store_begin(binding: Binding) -> Result<ports_Ticket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let journal = FirstEditJournal {};
    return journal.begin(binding);
}

public flow edit_operation_store_complete(ticket: ports_Ticket) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let journal = FirstEditJournal {};
    return journal.complete(ticket);
}

public flow edit_operation_store_inspect(id: string, workspace: string, path: string) -> Result<
    Option<Record>,
    string
> {
    let journal = FirstEditJournal {};
    return journal.inspect(Selector {
        id,
        workspace,
        path
    });
}

public flow history_followup_edit_store_available() -> Result<bool, string> {
    let journal = FollowupEditJournal {};
    return journal.available();
}

public flow history_followup_edit_store_begin(binding: Binding) -> Result<ports_Ticket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let journal = FollowupEditJournal {};
    return journal.begin(binding);
}

public flow history_followup_edit_store_complete(ticket: ports_Ticket) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let journal = FollowupEditJournal {};
    return journal.complete(ticket);
}

public flow history_followup_edit_store_inspect(id: string, workspace: string, path: string) -> Result<
    Option<Record>,
    string
> {
    let journal = FollowupEditJournal {};
    return journal.inspect(Selector {
        id,
        workspace,
        path
    });
}

flow key(id: string) -> string {
    return "work:" + id;
}

flow read(id: string) -> Option<MemoryEntry<string, work_record_Record>> {
    return Work.Rows.get_entry(key(id));
}

public flow work_record_store_available(id: string, workspace: string, path: string) -> Result<bool, string> {
    let error = selector_error(id, workspace, path);
    if error != "" {
        return Err(error);
    }
    return match read(id) {
        None() => Ok(true),
        Some(_) => Err("work record key already exists; no adoption or retry")
    };
}

type RecordRows = {
    name: string
};

impl RecordRows ~ CasRows<work_record_Record> {
    flow target(self) -> Target ![] {
        return Target {
            store = ["Rows"],
            region = "nomo-work-record-v1",
            key = self.name,
            label = "work record"
        };
    }

    flow submit(self, value: work_record_Record, condition: WriteCondition) -> Submission ![
        Memory,
        Error<StorageError>
    ] {
        return submit_native(Work.Rows, self.name, value, condition);
    }

    flow read(self) -> Result<Option<MemoryEntry<string, work_record_Record>>, string> {
        return Ok(Work.Rows.get_entry(self.name));
    }

    flow same(self, left: work_record_Record, right: work_record_Record) -> bool ![] {
        return work_same_record(left, right);
    }
}

flow write(row: work_record_Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    match validate(row) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let selected = key(row.binding.id);
    return commit_once<work_record_Record, RecordRows>(RecordRows {
        name = selected
    }, row, condition, None());
}

public flow publish(row: work_record_Record) -> Result<Ticket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if row.phase != "summary-unconfirmed" {
        return Err("initial work record must leave summary unconfirmed");
    }
    let version = match write(row, Missing) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Ticket {
        row,
        version
    });
}

public flow work_record_store_complete(ticket: Ticket, summary: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if ticket.row.phase != "summary-unconfirmed" {
        return Err("work update requires the original partial ticket");
    }
    let row = match confirm(ticket.row, summary) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let before = match read(ticket.row.binding.id) {
        Some(value) => value,
        None() => {
            return Err("partial work record missing; no retry");
        }
    };
    if before.key != key(ticket.row.binding.id) || !work_same_record(before.value, ticket.row)
        || before.version.opaque != ticket.version.opaque {
        return Err("partial work record binding or version changed; no retry");
    }
    let version = match write(row, WriteCondition.Match(before.version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if version.opaque == before.version.opaque {
        return Err("work confirmation version did not change");
    }
    return Ok(true);
}

// Logical read-only: captured facts never authorize replay or assert current File state.
public flow work_record_store_inspect(id: string, workspace: string, path: string) -> Result<
    Option<work_record_Record>,
    string
> {
    let error = selector_error(id, workspace, path);
    if error != "" {
        return Err(error);
    }
    let before = match read(id) {
        Some(value) => value,
        None() => {
            return Ok(None());
        }
    };
    if before.key != key(id) {
        return Err("work record key mismatch");
    }
    let captured = match validate(before.value) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if captured.binding.id != id || captured.binding.workspace != workspace || captured.binding.path != path {
        return Err("work record identity or workspace binding mismatch");
    }
    let journal = match edit_operation_store_inspect(id, workspace, path) {
        Ok(Some(value)) => value,
        Ok(None()) => {
            return Err("work record has no confirmed edit journal");
        }
        Err(error) => {
            return Err(error);
        }
    };
    if journal.phase != "completed" || !same_binding(journal.binding, captured.binding) {
        return Err("work record confirmed edit binding mismatch");
    }
    let after = match read(id) {
        Some(value) => value,
        None() => {
            return Err("work record disappeared during show");
        }
    };
    if after.key != before.key || after.version.opaque != before.version.opaque
        || !work_same_record(after.value, before.value) {
        return Err("work record changed during show");
    }
    return Ok(Some(before.value));
}

public type Ticket = {
    row: work_record_Record,
    version: MemoryVersion
};
