module nomo.domain.sessions.cas_rows;

import std.memory.{MemoryWriteReceipt, MemoryWriteRejection, StorageOperationRef, WriteOutcome};

public type Target = { region: string, store: Array<string>, key: string, label: string };

public type Submission = { operation: StorageOperationRef, outcome: WriteOutcome<MemoryWriteReceipt<string>, MemoryWriteRejection> };
