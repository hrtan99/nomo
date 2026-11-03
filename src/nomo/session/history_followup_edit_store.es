module nomo.session.history_followup_edit_store;

import std.memory.MemoryVersion;
import nomo.session.edit_operation.{Binding, Record};
import nomo.session.edit_operation_store.{available_in, begin_in, complete_in, inspect_in};

public type Ticket = { binding: Binding, version: MemoryVersion };
public flow available() -> Result<bool, string> { return available_in(true); }
public flow begin(binding: Binding) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return match begin_in(binding, true) { Ok(version) => Ok(Ticket { binding = binding, version = version }), Err(error) => Err(error) };
}
public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return complete_in(ticket.binding, ticket.version, true); }
public flow inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string> { return inspect_in(id, workspace, path, true); }
