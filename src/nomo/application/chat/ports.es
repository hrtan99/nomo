module nomo.application.chat.ports;

import nomo.domain.harness.harness_tool_chat_contract.TurnResult;

// Storage adapters keep their schema, CAS and redaction rules. The use case
// owns the shared create/load/reserve/readback and completion ordering.
public spec ChatRepository<Ticket> {
    flow load(self) -> Result<Option<Ticket>, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow create(self) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow reserve(self, current: Ticket, request: string) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow verified(self, ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow finish(self, ticket: Ticket, result: TurnResult) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow exists_error(self) -> string ![];
    flow missing_error(self) -> string ![];
    flow unresolved_error(self) -> string ![];
}
