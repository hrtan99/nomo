module nomo.adapters.storage.legacy.history_followup_edit_store;

import nomo.session.edit_operation.{Binding, Record};
import nomo.adapters.storage.legacy.edit_operation_store.FollowupEditJournal;
import nomo.domain.sessions.edit_operation_store.Ticket;
import nomo.domain.mutations.edit_contract.Selector;

public flow available() -> Result<bool, string> { let journal = FollowupEditJournal {}; return journal.available(); }

public flow begin(binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { let journal = FollowupEditJournal {}; return journal.begin(binding); }

public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { let journal = FollowupEditJournal {}; return journal.complete(ticket); }

public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> { let journal = FollowupEditJournal {}; return journal.inspect(Selector { id, workspace, path }); }
