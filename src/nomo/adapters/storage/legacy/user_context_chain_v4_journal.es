module nomo.adapters.storage.legacy.user_context_chain_v4_journal;

import nomo.domain.editing.{Binding, selector_error};
import nomo.domain.sessions.chain.{CapturedJournal, invalid as chain_invalid};
import nomo.domain.sessions.user_context_chain_v4.{JournalRecord, RootIdentity, identity_error};
import std.memory.{MemoryEntry, MemoryVersion, MemoryWriteChange, Missing, StorageDurability, WriteCondition, WriteOutcome};

public type Ticket = {
    row: JournalRecord,
    version: MemoryVersion
};

flow key(turn: i32) -> string {
    return if turn == 1 {
        "turn:1"
    } else {
        "turn:2"
    };
}

flow read(turn: i32) -> Option<MemoryEntry<string, JournalRecord>> {
    return UserContextJournal.Rows.get_entry(key(turn));
}

public flow invalid(row: JournalRecord) -> string {
    if row.format != 4 {
        return "invalid v4 edit journal format";
    }
    let root = identity_error(row.root);
    if root != "" {
        return root;
    }
    return chain_invalid(
        CapturedJournal {
            format = 2,
            chain = row.chain,
            turn = row.turn,
            phase = row.phase,
            binding = row.binding
        }
    );
}

flow write(row: JournalRecord, condition: WriteCondition) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let error = invalid(row);
    if error != "" {
        return Err(error);
    }
    let selected = key(row.turn);
    let intent = UserContextJournal.Rows.prepare_put(selected, row, condition);
    let operation = intent.operation_ref();
    let receipt = match intent.commit() {
        WriteOutcome.Unknown(_) => {
            return Err("v4 edit journal commit unknown; no retry");
        },
        WriteOutcome.NotCommitted(_, _) => {
            return Err("v4 edit journal commit refused; no retry");
        },
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint
        || receipt.target.key != selected || receipt.target.region != "nomo-user-context-edit-v4"
        || receipt.target.store != ["Rows"] {
        return Err("v4 edit journal receipt mismatch; no retry");
    }
    let durable = match receipt.durability {
        StorageDurability.Durable() => true,
        _ => false
    };
    if !durable {
        return Err("durable SQLite v4 edit receipt required");
    }
    let version = match receipt.change {
        MemoryWriteChange.Written(value) => value,
        _ => {
            return Err("v4 edit written-version receipt required");
        }
    };
    let after = match read(row.turn) {
        Some(value) => value,
        None() => {
            return Err("v4 edit journal readback missing; no retry");
        }
    };
    if after.key != selected || after.value != row || after.version.opaque != version.opaque {
        return Err("v4 edit journal full readback mismatch; no retry");
    }
    return Ok(version);
}

public flow available(turn: i32) -> Result<bool, string> {
    if turn != 1 && turn != 2 {
        return Err("v4 edit journal permits only two turns");
    }
    return match read(turn) {
        None() => Ok(true),
        Some(_) => Err("v4 edit journal slot consumed; no retry")
    };
}

public flow begin(chain: string, turn: i32, root: RootIdentity, binding: Binding) -> Result<Ticket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
] {
    let row = JournalRecord {
        format = 4,
        chain,
        turn,
        phase = "intent",
        root,
        binding
    };
    let error = invalid(row);
    if error != "" {
        return Err(error);
    }
    match available(turn) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let version = match write(row, Missing) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Ticket {
        row,
        version
    });
}

public flow complete(ticket: Ticket) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(ticket.row);
    if error != "" {
        return Err(error);
    }
    if ticket.row.phase != "intent" {
        return Err("v4 edit completion requires the exact intent");
    }
    let before = match read(ticket.row.turn) {
        Some(value) => value,
        None() => {
            return Err("v4 edit intent missing; no retry");
        }
    };
    if before.key != key(ticket.row.turn) || before.value != ticket.row
        || before.version.opaque != ticket.version.opaque {
        return Err("v4 edit intent or version changed; no retry");
    }
    let row = JournalRecord {
        format = 4,
        chain = ticket.row.chain,
        turn = ticket.row.turn,
        phase = "completed",
        root = ticket.row.root,
        binding = ticket.row.binding
    };
    let version = match write(row, WriteCondition.Match(before.version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if version.opaque == before.version.opaque {
        return Err("v4 edit completion version did not change");
    }
    return Ok(true);
}

public flow inspect(chain: string, turn: i32, id: string, workspace: string, path: string, root: RootIdentity) -> Result<
    Option<JournalRecord>,
    string
> {
    let error = selector_error(id, workspace, path);
    if error != "" {
        return Err(error);
    }
    let root_error = identity_error(root);
    if root_error != "" {
        return Err(root_error);
    }
    if turn != 1 && turn != 2 {
        return Err("v4 edit journal permits only two turns");
    }
    let before = match read(turn) {
        Some(value) => value,
        None() => {
            return Ok(None());
        }
    };
    let invalid_row = invalid(before.value);
    if invalid_row != "" {
        return Err(invalid_row);
    }
    let row = before.value;
    if before.key != key(turn) || row.chain != chain || row.turn != turn || row.binding.id != id
        || row.binding.workspace != workspace || row.binding.path != path || row.root != root {
        return Err("v4 edit journal selected binding mismatch");
    }
    let after = match read(turn) {
        Some(value) => value,
        None() => {
            return Err("v4 edit journal disappeared during inspect");
        }
    };
    if after != before {
        return Err("v4 edit journal changed during inspect");
    }
    return Ok(Some(row));
}

alias UserContextJournalSchema = MemoryRegion<{
    Rows: Store<string, JournalRecord>
}>;

public let UserContextJournal = std.memory.region<UserContextJournalSchema>(
    stable_id = "nomo-user-context-edit-v4",
    store = "user-context-edit"
);
