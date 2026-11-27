module nomo.adapters.storage.work_persistence;

import nomo.application.work.ports.WorkPersistence;
import nomo.domain.work.protocol.Summary;
import nomo.core.conversation.Event;
import nomo.session.edit_operation.Binding;
import nomo.domain.sessions.redaction.Policy;
import nomo.domain.sessions.edit_operation_store.Ticket as EditTicket;
import nomo.adapters.storage.legacy.edit_operation_store.{FirstEditJournal, FollowupEditJournal};
import nomo.adapters.storage.legacy.edit_operation_store as first_edits;
import nomo.adapters.storage.legacy.history_followup_edit_store as followup_edits;
import nomo.adapters.storage.legacy.history_work_guard as first_work;
import nomo.domain.sessions.history_work_guard.Ticket as FirstWorkTicket;
import nomo.adapters.storage.legacy.history_followup_guard as followup_work;
import nomo.domain.sessions.history_followup_guard.Ticket as FollowupWorkTicket;
import nomo.adapters.storage.legacy.recoverable_work_store as recoverable_work;
import nomo.domain.sessions.recoverable_work_store.Ticket as RecoverableWorkTicket;
import nomo.adapters.storage.legacy.recoverable_followup_store as recoverable_followup;
import nomo.domain.sessions.recoverable_followup_store.Ticket as RecoverableFollowupTicket;
import nomo.adapters.storage.legacy.continuous_work as continuous;
import nomo.domain.sessions.continuous_work.Stored;

public type FirstPersistence = { ticket: FirstWorkTicket, journal: FirstEditJournal };
impl FirstPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        match first_work.claim(self.ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
        return self.journal.begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return self.journal.complete(ticket);
    }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return first_work.finish(self.ticket, summary.answer, summary.state);
    }
}

public type FollowupPersistence = { ticket: FollowupWorkTicket, journal: FollowupEditJournal };
impl FollowupPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        match followup_work.claim(self.ticket) { Ok(_) => (), Err(error) => { return Err(error); } }
        return self.journal.begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return self.journal.complete(ticket);
    }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return followup_work.finish(self.ticket, summary.answer, summary.state);
    }
}

public type RecoverableFirstPersistence = { ticket: RecoverableWorkTicket, redaction: Policy, binding: string };
impl RecoverableFirstPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        match recoverable_work.claim(self.ticket, self.redaction, self.binding) { Ok(_) => (), Err(error) => { return Err(error); } }
        return first_edits.begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return first_edits.complete(ticket); }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return recoverable_work.finish(self.ticket, summary.answer, summary.state, records, self.redaction, self.binding);
    }
}

public type RecoverableFollowupPersistence = { ticket: RecoverableFollowupTicket, redaction: Policy, binding: string };
impl RecoverableFollowupPersistence ~ WorkPersistence<EditTicket, bool> {
    flow begin(self, selected: Binding) -> Result<EditTicket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        match recoverable_followup.claim(self.ticket, self.redaction, self.binding) { Ok(_) => (), Err(error) => { return Err(error); } }
        return followup_edits.begin(selected);
    }
    flow complete(self, ticket: EditTicket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return followup_edits.complete(ticket); }
    flow finish(self, edited: bool, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] { return recoverable_followup.finish(self.ticket, summary.answer, summary.state, records, self.redaction, self.binding); }
}

public type ContinuousPersistence = { ticket: Stored, redaction: Policy };
impl ContinuousPersistence ~ WorkPersistence<Stored, Stored> {
    flow begin(self, selected: Binding) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] { return continuous.edit_intent(self.ticket, selected); }
    flow complete(self, ticket: Stored) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] { return continuous.edit_complete(ticket); }
    flow finish(self, edited: Stored, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
        return match continuous.finish(edited, summary.answer, if summary.model_generated { "model" } else { "system" }, summary.state, records, self.redaction) { Ok(_) => Ok(true), Err(error) => Err(error) };
    }
}
