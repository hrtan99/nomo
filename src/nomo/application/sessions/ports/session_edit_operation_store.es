module nomo.application.sessions.ports.session_edit_operation_store;

import nomo.session.edit_operation.{Binding, Record};
import nomo.domain.mutations.edit_contract.Selector;
import nomo.domain.sessions.edit_operation_store.Ticket;

public spec EditJournal {
    flow available(self) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow begin(self, binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow complete(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow inspect(self, selector: Selector) -> Result<Option<Record>, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
