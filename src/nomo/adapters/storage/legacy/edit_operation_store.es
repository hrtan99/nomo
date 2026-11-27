module nomo.adapters.storage.legacy.edit_operation_store;

import std.memory.{WriteCondition, MemoryEntry};
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.domain.sessions.cas_rows.{Target, Submission};
import nomo.adapters.storage.legacy.cas_rows.submit_native;
import nomo.application.sessions.edit_operations;
import nomo.session.edit_operation.{Binding, Record};
import nomo.domain.sessions.edit_operation.same_record;
import nomo.domain.mutations.edit_contract.Selector;
import nomo.domain.sessions.edit_operation_store.Ticket;
import nomo.application.sessions.ports.session_edit_operation_store.EditJournal;
import nomo.session.edit_operation_store.{Operations, Followups};

public type FirstEditJournal = {};

public type FollowupEditJournal = {};

impl FirstEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-edit-operation-v1", key = "operation", label = "edit journal" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Operations.Rows, "operation", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Operations.Rows.get_entry("operation")); }
    flow same(self, left: Record, right: Record) -> bool ![] { return same_record(left, right); }
}

impl FirstEditJournal ~ EditJournal {
    flow available(self) -> Result<bool, string> { return edit_operations.available(self); }
    flow begin(self, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return edit_operations.begin(self, binding); }
    flow complete(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return edit_operations.complete(self, ticket); }
    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> { return edit_operations.inspect(self, selector); }
}

impl FollowupEditJournal ~ CasRows<Record> {
    flow target(self) -> Target ![] { return Target { store = ["Rows"], region = "nomo-edit-followup-v1", key = "operation", label = "edit journal" }; }
    flow submit(self, value: Record, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>] { return submit_native(Followups.Rows, "operation", value, condition); }
    flow read(self) -> Result<Option<MemoryEntry<string, Record>>, string> { return Ok(Followups.Rows.get_entry("operation")); }
    flow same(self, left: Record, right: Record) -> bool ![] { return same_record(left, right); }
}

impl FollowupEditJournal ~ EditJournal {
    flow available(self) -> Result<bool, string> { return edit_operations.available(self); }
    flow begin(self, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return edit_operations.begin(self, binding); }
    flow complete(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return edit_operations.complete(self, ticket); }
    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> { return edit_operations.inspect(self, selector); }
}

public flow available() -> Result<bool, string> { let journal = FirstEditJournal {}; return journal.available(); }

public flow begin(binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { let journal = FirstEditJournal {}; return journal.begin(binding); }

public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { let journal = FirstEditJournal {}; return journal.complete(ticket); }

public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> { let journal = FirstEditJournal {}; return journal.inspect(Selector { id, workspace, path }); }
