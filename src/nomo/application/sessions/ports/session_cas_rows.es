module nomo.application.sessions.ports.session_cas_rows;

import std.memory.{MemoryEntry, WriteCondition};
import nomo.domain.sessions.cas_rows.{Target, Submission};

public spec CasRows<Row> {
    flow target(self) -> Target ![];
    flow submit(self, value: Row, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>];
    flow read(self) -> Result<Option<MemoryEntry<string, Row>>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow same(self, left: Row, right: Row) -> bool ![];
}
