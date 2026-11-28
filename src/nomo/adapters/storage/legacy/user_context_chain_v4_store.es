module nomo.adapters.storage.legacy.user_context_chain_v4_store;

import nomo.adapters.storage.legacy.user_context_chain_v4_journal.{available, inspect as user_context_chain_v4_journal_inspect};
import nomo.domain.editing.{same_binding, selector_error};
import nomo.domain.sessions.chain.Caps;
import nomo.domain.sessions.user_context_chain_v4.{
    Record,
    RootIdentity,
    confirm,
    identity_error,
    initial,
    linked,
    publish_partial as user_context_chain_v4_publish_partial,
    successor,
    validate
};
import nomo.domain.sessions.user_context_chain_v4_context.parent_facts;
import nomo.domain.sessions.user_context_chain_v4_store.Ticket;
import nomo.domain.sessions.work.StoredWorkRecord;
import std.memory.{MemoryEntry, MemoryVersion, MemoryWriteChange, Missing, StorageDurability, WriteCondition, WriteOutcome};

flow key(turn: i32) -> string {
    return if turn == 1 {
        "turn:1"
    } else {
        "turn:2"
    };
}

flow read(turn: i32) -> Option<MemoryEntry<string, Record>> {
    return UserContextChain.Rows.get_entry(key(turn));
}

flow journal_error(row: Record) -> string {
    let base = row.base;
    let journal = match user_context_chain_v4_journal_inspect(
        base.chain,
        base.turn,
        base.id,
        base.workspace,
        base.path,
        row.root
    ) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    match journal {
        Some(value) => match base.work {
            Some(work) => {
                if value.phase != "completed" || !same_binding(value.binding, work.binding) {
                    return "v4 work and completed edit journal differ";
                }
            },
            None() => (),
        },
        None() => {
            if base.work != None() {
                return "v4 work has no completed edit journal";
            }
        },
    }
    return "";
}

flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
    ,
    Error<BudgetExceeded>
] {
    let error = validate(row);
    if error != "" {
        return Err(error);
    }
    let selected = key(row.base.turn);
    let intent = UserContextChain.Rows.prepare_put(selected, row, condition);
    let operation = intent.operation_ref();
    let receipt = match intent.commit() {
        WriteOutcome.Unknown(_) => {
            return Err("v4 chain commit unknown; no retry");
        }
        WriteOutcome.NotCommitted(_, _) => {
            return Err("v4 chain commit refused; no retry");
        }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint
        || receipt.target.key != selected || receipt.target.region != "nomo-user-context-chain-v4"
        || receipt.target.store != ["Rows"] {
        return Err("v4 chain receipt mismatch; no retry");
    }
    let durable = match receipt.durability {
        StorageDurability.Durable() => true,
        _ => false
    };
    if !durable {
        return Err("durable SQLite v4 chain receipt required");
    }
    let version = match receipt.change {
        MemoryWriteChange.Written(value) => value,
        _ => {
            return Err("v4 chain written-version receipt required");
        }
    };
    let after = match read(row.base.turn) {
        Some(value) => value,
        None() => {
            return Err("v4 chain readback missing; no retry");
        }
    };
    if after.key != selected || after.value != row || after.version.opaque != version.opaque {
        return Err("v4 chain full readback mismatch; no retry");
    }
    return Ok(version);
}

public flow read_parent(id: string, workspace: string, path: string, root: RootIdentity) -> Result<
    MemoryEntry<string, Record>,
    string
> {
    let error = selector_error(id, workspace, path);
    if error != "" {
        return Err(error);
    }
    let before = match read(1) {
        Some(value) => value,
        None() => {
            return Err("v4 parent missing; legacy rows are not executable parents");
        }
    };
    let invalid = validate(before.value);
    if invalid != "" {
        return Err(invalid);
    }
    let row = before.value;
    let base = row.base;
    if before.key != key(1) || base.turn != 1 || base.phase != "summary-confirmed" || base.id != id
        || base.chain != id || base.workspace != workspace || base.path != path || row.root != root {
        return Err("v4 parent or read-root binding mismatch");
    }
    let journal = journal_error(row);
    if journal != "" {
        return Err(journal);
    }
    let after = match read(1) {
        Some(value) => value,
        None() => {
            return Err("v4 parent disappeared; no retry");
        }
    };
    if after != before {
        return Err("v4 parent changed during reload; no retry");
    }
    return Ok(before);
}

flow parent_error(ticket: Ticket, row: Record) -> string {
    if row.base.turn == 1 {
        if ticket.parent != None() {
            return "v4 root ticket unexpectedly has a parent";
        }
        return "";
    }
    let parent = match ticket.parent {
        Some(value) => value,
        None() => {
            return "v4 successor ticket has no parent";
        }
    };
    let error = linked(parent.value, parent.version.opaque, row);
    if error != "" {
        return error;
    }
    let current = match read_parent(row.base.parent_id, row.base.workspace, row.base.path, row.root) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    if current != parent {
        return "v4 parent value or version changed; no retry";
    }
    return "";
}

public flow claim(ticket: Ticket) -> Result<bool, string> {
    let error = validate(ticket.row);
    if error != "" {
        return Err(error);
    }
    let parent = parent_error(ticket, ticket.row);
    if parent != "" {
        return Err(parent);
    }
    let before = match read(ticket.row.base.turn) {
        Some(value) => value,
        None() => {
            return Err("v4 admission missing; no retry");
        }
    };
    if before.key != key(ticket.row.base.turn) || before.value != ticket.row
        || before.version.opaque != ticket.version.opaque {
        return Err("v4 admission value or version changed; no retry");
    }
    let journal = journal_error(ticket.row);
    if journal != "" {
        return Err(journal);
    }
    return Ok(true);
}

public flow admit_first(
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps,
    root: RootIdentity
) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = match initial(id, workspace, path, request, allowed, policy, root) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if read(1) != None() || read(2) != None() {
        return Err("v4 root or turn slot consumed; no retry");
    }
    match available(1) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    match available(2) {
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
        version,
        parent = None()
    });
}

public flow admit_continue(
    parent_id: string,
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps,
    root: RootIdentity,
    expected_parent: MemoryEntry<string, Record>
) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let error = selector_error(id, workspace, path);
    if error != "" {
        return Err(error);
    }
    if read(2) != None() {
        return Err("v4 successor slot consumed; no retry or third turn");
    }
    match available(2) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let parent = match read_parent(parent_id, workspace, path, root) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if parent != expected_parent {
        return Err("v4 parent differs from preflight snapshot");
    }
    // The complete bounded parent projection must fit before consuming turn 2.
    match parent_facts(parent.value, root) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let row = match successor(parent.value, parent.version.opaque, id, request, allowed, policy, root) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let version = match write(row, Missing) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let ticket = Ticket {
        row,
        version,
        parent = Some(parent)
    };
    match claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    return Ok(ticket);
}

public flow publish_partial(ticket: Ticket, work: StoredWorkRecord) -> Result<Ticket, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
    ,
    Error<BudgetExceeded>
] {
    let row = match user_context_chain_v4_publish_partial(ticket.row, work) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let parent = parent_error(ticket, row);
    if parent != "" {
        return Err(parent);
    }
    let journal = journal_error(row);
    if journal != "" {
        return Err(journal);
    }
    let version = match write(row, WriteCondition.Match(ticket.version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if version.opaque == ticket.version.opaque {
        return Err("v4 partial publication version did not change");
    }
    return Ok(ticket {
        row,
        version
    });
}

public flow complete(ticket: Ticket, summary: string) -> Result<bool, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
    ,
    Error<BudgetExceeded>
] {
    let row = match confirm(ticket.row, summary) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match claim(ticket) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let parent = parent_error(ticket, row);
    if parent != "" {
        return Err(parent);
    }
    let journal = journal_error(row);
    if journal != "" {
        return Err(journal);
    }
    let version = match write(row, WriteCondition.Match(ticket.version)) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if version.opaque == ticket.version.opaque {
        return Err("v4 confirmation version did not change");
    }
    let after = parent_error(ticket, row);
    if after != "" {
        return Err(after);
    }
    return Ok(true);
}

// Show validates the whole stored graph and never grants authority to resume.
public flow inspect(id: string, workspace: string, path: string, root: RootIdentity) -> Result<
    Option<Record>,
    string
> {
    let error = selector_error(id, workspace, path);
    if error != "" {
        return Err(error);
    }
    let invalid_root = identity_error(root);
    if invalid_root != "" {
        return Err(invalid_root);
    }
    let first_snapshot = read(1);
    let child_snapshot = read(2);
    let first = match first_snapshot {
        Some(value) => value,
        None() => {
            if child_snapshot != None() {
                return Err("v4 successor exists without its root");
            }
            match available(1) {
                Ok(_) => (),
                Err(_) => {
                    return Err("v4 orphan first journal");
                }
            }
            match available(2) {
                Ok(_) => (),
                Err(_) => {
                    return Err("v4 orphan second journal");
                }
            }
            return Ok(None());
        }
    };
    let invalid = validate(first.value);
    if invalid != "" {
        return Err(invalid);
    }
    if first.key != key(1) || first.value.base.turn != 1 || first.value.root != root
        || first.value.base.workspace != workspace || first.value.base.path != path {
        return Err("v4 root slot or binding mismatch");
    }
    let journal = journal_error(first.value);
    if journal != "" {
        return Err(journal);
    }
    var selected = first.value;
    var found = first.value.base.id == id;
    match child_snapshot {
        Some(child) => {
            if child.key != key(2) || child.value.base.turn != 2 {
                return Err("v4 successor slot mismatch");
            }
            let lineage = linked(first.value, first.version.opaque, child.value);
            if lineage != "" {
                return Err(lineage);
            }
            let edit = journal_error(child.value);
            if edit != "" {
                return Err(edit);
            }
            if child.value.base.id == id {
                selected = child.value;
                found = true;
            }
        }
        None() => match available(2) {
            Ok(_) => (),
            Err(_) => {
                return Err("v4 orphan second journal");
            }
        },
    }
    if !found {
        return Err("v4 selected ID missing");
    }
    if read(1) != first_snapshot || read(2) != child_snapshot {
        return Err("v4 chain changed during show");
    }
    return Ok(Some(selected));
}

alias UserContextChainSchema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let UserContextChain = std.memory.region<UserContextChainSchema>(
    stable_id = "nomo-user-context-chain-v4",
    store = "user-context-chain"
);
