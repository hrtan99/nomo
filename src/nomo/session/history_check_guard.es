module nomo.session.history_check_guard;

import std.memory.MemoryEntry;
public import nomo.session.history_check_store.{Record, invalid_values};
import nomo.session.history_check_store.{plan as plan_rows, start as start_rows, finish as finish_rows, inspect as inspect_rows};
import nomo.session.history_work_guard.{Ticket, claim};
import nomo.session.history_first_check_rows.rows;
public flow invalid(value: Record) -> string { return invalid_values(value.format, value.phase, value.id, value.digest, value.outcome, value.exit_code, true); }
public flow plan(ticket: Ticket, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket) { Ok(_) => plan_rows(rows(), ticket.record.id, digest), Err(error) => Err(error) }
}
public flow start(id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return start_rows(rows(), id, digest); }
public flow finish(id: string, digest: string, outcome: string, exit_code: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return finish_rows(rows(), id, digest, outcome, exit_code); }
public flow inspect() -> Result<Option<Record>, string> { return inspect_rows(rows()); }
