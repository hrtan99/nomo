module nomo.application.sessions.ports;

import nomo.application.editing.ports.Ticket as ports_Ticket;
import nomo.core.conversation.Event;
import nomo.domain.editing.Selector;
import nomo.domain.harness.chat.TurnResult;
import nomo.domain.sessions.chain.{
    CapturedShow,
    ObservationPass,
    ObservedRow,
    Snapshot as chain_Snapshot,
    TurnRequest,
    WorkOutcome
};
import nomo.domain.sessions.work.{CheckFacts, CheckResult, Facts};
import nomo.session.chat_session_contract.Session;
import nomo.session.edit_operation.{Binding, Record as edit_operation_Record};
import nomo.session.history_check_store.Record as history_check_store_Record;
import nomo.session.history_followup_guard.Record as history_followup_guard_Record;
import nomo.session.history_work_guard.Record as history_work_guard_Record;
import nomo.session.work_chain.Record;
import std.memory.{
    MemoryEntry,
    MemoryVersion,
    MemoryWriteReceipt,
    MemoryWriteRejection,
    StorageOperationRef,
    WriteCondition,
    WriteOutcome
};

// Storage adapters keep their schema, CAS and redaction rules. The use case
// owns the shared create/load/reserve/readback and completion ordering.
public spec ChatRepository<Ticket> {
    flow load(self) -> Result<Option<Ticket>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow create(self) -> Result<Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow reserve(self, current: Ticket, request: string) -> Result<Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow verified(self, ticket: Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow finish(self, ticket: Ticket, result: TurnResult) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow exists_error(self) -> string ![];
    flow missing_error(self) -> string ![];
    flow unresolved_error(self) -> string ![];
}

public spec CheckFactsReader {
    flow read(self) -> Result<Option<CheckFacts>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec CheckLifecycle {
    flow start(self, id: string, digest: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow finish(self, id: string, digest: string, result: CheckResult) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow abandon(self, id: string) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

// Write-only consumers need no decoding authority. Round-trip consumers use
// the full versioned codec contract without owning a concrete record format.
public spec RecordEncoder<T> {
    flow encode(self, value: T) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>];
}

public spec RecordCodec<T> {
    flow encode(self, value: T) -> Result<string, string> ![Error<IndexError>, Error<BudgetExceeded>];
    flow decode(self, raw: string) -> Result<T, string> ![Error<IndexError>, Error<BudgetExceeded>];
}

public flow decode_record<T, C ~ RecordCodec<T>>(codec: C, raw: string) -> Result<T, string> ![
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return codec.decode(raw);
}

public effect DiscoveryAuthority {
    action inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string>;
    action confirmed_parent(id: string, workspace: string, path: string) -> Result<ObservedRow, string>;
}

public effect SessionObservation {
    action capture(pass: ObservationPass) -> Result<chain_Snapshot, string>;
}

public effect TerminalWork {
    action execute(request: TurnRequest) -> WorkOutcome;
}

public effect TerminalRead {
    action show(selected: Selector) -> Result<Option<CapturedShow>, string>;
    action latest(workspace: string, path: string) -> Result<string, string>;
}

public spec WorkFactsReader {
    flow snapshot(self) -> Result<Facts, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec FollowupPredecessors {
    flow work(self) -> Result<Option<history_work_guard_Record>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow edit(self, id: string, workspace: string, path: string) -> Result<
        Option<edit_operation_Record>,
        string
    > ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow check(self) -> Result<Option<history_check_store_Record>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec PriorChatReader {
    flow load(self) -> Result<Option<Entry>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec CasRows<Row> {
    flow target(self) -> Target ![];
    flow submit(self, value: Row, condition: WriteCondition) -> Submission ![Memory, Error<StorageError>];
    flow read(self) -> Result<Option<MemoryEntry<string, Row>>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow same(self, left: Row, right: Row) -> bool ![];
}

// Storage layouts and admission proofs stay in their concrete adapters.
public spec CheckAccess {
    flow work(self) -> Result<Option<history_work_guard_Record>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow completed_edit(self, id: string, workspace: string, path: string) -> string ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec EditJournal {
    flow available(self) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow begin(self, binding: Binding) -> Result<ports_Ticket, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow complete(self, ticket: ports_Ticket) -> Result<bool, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow inspect(self, selector: Selector) -> Result<Option<edit_operation_Record>, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, history_check_store_Record>> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>
    ];
    flow write(self, row: history_check_store_Record, condition: WriteCondition) -> Result<
        MemoryVersion,
        string
    > ![Memory, Error<StorageError>, Error<IndexError>];
    flow confirmed_work(self, id: string) -> string ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow recorded_work_id(self) -> Result<string, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
    flow allow_abandoned(self) -> bool ![];
}

// Status readers are read-only projections. Renderers receive typed data and
// never infer authority, current workspace identity or effect completion.
public spec SessionStatusReader<Snapshot> {
    flow snapshot(self) -> Result<Snapshot, string> ![
        Memory,
        Error<StorageError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public type Target = {
    region: string,
    store: Array<string>,
    key: string,
    label: string
};

public type Submission = {
    operation: StorageOperationRef,
    outcome: WriteOutcome<MemoryWriteReceipt<string>, MemoryWriteRejection>
};

public type Entry = {
    key: string,
    value: Session,
    version: MemoryVersion,
    first_count: usize,
    events: Array<Event>,
    schema: i32,
    pending: bool
};

public type HistoricalFollowupTicket = {
    record: history_followup_guard_Record,
    version: MemoryVersion,
    history: Entry
};

public type HistoricalWorkTicket = {
    record: history_work_guard_Record,
    version: MemoryVersion,
    history: Entry
};
