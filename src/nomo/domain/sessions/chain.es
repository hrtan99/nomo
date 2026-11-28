module nomo.domain.sessions.chain;

import nomo.domain.editing.{Selector as editing_Selector, binding_error, same_binding, selector_error};
import nomo.domain.harness.loop.{allowed_error, question_error};
import nomo.domain.harness.work.{Context, context_error};
import nomo.domain.limits.context_bytes;
import nomo.domain.sessions.work.{confirm as work_confirm, validate};
import nomo.domain.wire.{digest, encode};
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.edit_operation.Binding;
import nomo.session.work_chain.{Caps, Record};
import nomo.session.work_record.Record as work_record_Record;
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import std.text.{char_count, from_i32, from_usize, len, parse_i32, split};

public type ParentFacts = {
    chain: string,
    root: string,
    id: string,
    turn: i32,
    after_digest: string,
    request: string,
    read_task: string,
    operation: string,
    files: Array<string>,
    literal: string,
    outcome: string,
    result: string,
    read_summary: string,
    final_summary: string
};

public type Input = {
    current: Context,
    parent: Array<ParentFacts>
};

public flow parent_facts(parent: Record) -> Result<Array<ParentFacts>, string> {
    let invalid = work_chain_validate(parent);
    if invalid != "" {
        return Err(invalid);
    }
    if parent.turn != 1 || parent.phase != "summary-confirmed" {
        return Err("only a confirmed first v2 parent supplies context");
    }
    let record = match parent.work {
        Some(value) => value,
        None() => {
            return Err("confirmed parent work missing");
        }
    };
    let value = match validate(record) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let read = value.evidence;
    let result = [
        ParentFacts {
            chain = parent.chain,
            root = parent.chain,
            id = parent.id,
            turn = parent.turn,
            after_digest = value.binding.after_digest,
            request = read.request,
            read_task = read.task,
            operation = read.operation,
            files = read.files,
            literal = read.literal,
            outcome = read.outcome,
            result = read.result,
            read_summary = read.summary,
            final_summary = value.summary
        }
    ];
    let encoded = match encode(result, "parent facts conversion refused", "parent facts encoding refused") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if len(encoded) > context_bytes() {
        return Err("parent facts exceed 33554432 UTF-8 bytes before admission");
    }
    return Ok(result);
}

public flow combined(current: Context, parent: Array<ParentFacts>) -> Input {
    let error = context_error(current);
    if error != "" {
        abort(error);
    }
    if parent.len() > 1 {
        abort("at most one confirmed parent context");
    }
    let value = Input {
        current,
        parent
    };
    let message = Message.new(value);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match converted {
        Some(item) => item.body,
        None() => abort("chain context conversion refused"),
    };
    let encoded = match stringify(data) {
        Ok(item) => item,
        Err(_) => abort("chain context encoding refused"),
    };
    if len(encoded) > context_bytes() {
        abort("chain edit context exceeds 33554432 UTF-8 bytes");
    }
    return value;
}

public type Reservation = {
    available: Caps,
    remaining: Caps
};

public flow values(value: Caps) -> Array<i32> {
    return [
        value.steps,
        value.calls,
        value.generation,
        value.native_tokens,
        value.read_tools,
        value.scan,
        value.edit_reads,
        value.edit_read_bytes,
        value.atomic,
        value.atomic_bytes
    ];
}

flow caps(value: Array<i32>) -> Caps {
    return Caps {
        steps = value[0],
        calls = value[1],
        generation = value[2],
        native_tokens = value[3],
        read_tools = value[4],
        scan = value[5],
        edit_reads = value[6],
        edit_read_bytes = value[7],
        atomic = value[8],
        atomic_bytes = value[9]
    };
}

public flow lifetime() -> Caps {
    return caps([26, 14, 94208, 393216, 2, 8192, 6, 12288, 2, 4096]);
}

public flow maximum() -> Caps {
    return lifetime();
}

public flow turn_caps() -> Caps {
    return caps([13, 7, 47104, 196608, 1, 4096, 3, 6144, 1, 2048]);
}

public flow zero() -> Caps {
    return caps([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

public flow summary_reservation() -> Caps {
    return caps([1, 1, 2048, 65536, 0, 0, 0, 0, 0, 0]);
}

public flow caps_error(value: Caps) -> string {
    let numbers = values(value);
    let maximum = values(lifetime());
    var index: usize = 0;
    @limits([Iterations(10)]) while index < 10 {
        if numbers[index] < 0 || numbers[index] > maximum[index] {
            return "invalid bounded work-chain allowance";
        }
        index = index + 1;
    }
    return "";
}

public flow policy_error(value: Caps) -> string {
    let numbers = values(value);
    let maximum = values(turn_caps());
    var index: usize = 0;
    @limits([Iterations(10)]) while index < 10 {
        if numbers[index] < 0 || numbers[index] > maximum[index] {
            return "invalid current single-turn work-chain policy";
        }
        index = index + 1;
    }
    return "";
}

public flow reserve(saved: Caps, policy: Caps) -> Result<Reservation, string> {
    let invalid_saved = caps_error(saved);
    if invalid_saved != "" {
        return Err(invalid_saved);
    }
    let invalid_policy = policy_error(policy);
    if invalid_policy != "" {
        return Err(invalid_policy);
    }
    let previous = values(saved);
    let current = values(policy);
    let required = values(turn_caps());
    var admitted: Array<i32> = [];
    var remaining: Array<i32> = [];
    var index: usize = 0;
    @limits([Iterations(10)]) while index < 10 {
        let available = if previous[index] < current[index] {
            previous[index]
        } else {
            current[index]
        };
        if available < required[index] {
            return Err("work-chain remaining/current policy cannot reserve a complete turn");
        }
        admitted = admitted.push(available);
        remaining = remaining.push(previous[index] - required[index]);
        index = index + 1;
    }
    return Ok(Reservation {
        available = caps(admitted),
        remaining = caps(remaining)
    });
}

public flow parse_policy(raw: string) -> Result<Caps, string> {
    if char_count(raw) == 0 || char_count(raw) > 128 {
        return Err("expected ten canonical work-chain policy counters");
    }
    let fields = split(raw, ",");
    if fields.len() != 10 {
        return Err("expected ten canonical work-chain policy counters");
    }
    var numbers: Array<i32> = [];
    @limits([Iterations(10)]) for field in fields {
        if char_count(field) == 0 || char_count(field) > 6 {
            return Err("invalid canonical work-chain counter");
        }
        let number = match parse_i32(field) {
            Ok(value) => value,
            Err(_) => {
                return Err("invalid canonical work-chain counter");
            }
        };
        if number < 0 || from_i32(number) != field {
            return Err("invalid canonical work-chain counter");
        }
        numbers = numbers.push(number);
    }
    let result = caps(numbers);
    let invalid = policy_error(result);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(result);
}

public flow policy(raw: string) -> Result<Caps, string> {
    return parse_policy(raw);
}

flow serialized(row: Record) -> Result<string, string> {
    let encoded = match encode(
        row,
        "work-chain row conversion refused",
        "work-chain row serialization refused"
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if len(encoded) > context_bytes() {
        return Err("work-chain row exceeds 33554432 serialized UTF-8 bytes");
    }
    return Ok(encoded);
}

public flow work_chain_validate(row: Record) -> string {
    if (row.format != 2 && row.format != 3) || (row.turn != 1 && row.turn != 2) || (
        row.phase != "admitted"
            && row.phase != "summary-unconfirmed" && row.phase != "summary-confirmed"
    ) {
        return "invalid work-chain v2 format, turn or phase";
    }
    if row.format == 3 && row.turn != 1 {
        return "user-context work is limited to one turn";
    }
    let identity = selector_error(row.id, row.workspace, row.path);
    if identity != "" {
        return identity;
    }
    let chain = selector_error(row.chain, row.workspace, row.path);
    if chain != "" {
        return chain;
    }
    if row.region != "nomo.tools.edit_file.EditableRoot" {
        return "work-chain region binding mismatch";
    }
    let request = question_error(row.request);
    if request != "" {
        return request;
    }
    if row.allowed.len() > 2 {
        return "legacy work-chain supports at most two allowed files";
    }
    let allowed = allowed_error(row.allowed);
    if allowed != "" {
        return allowed;
    }
    if row.maximum != lifetime() {
        return "work-chain lifetime allowance changed";
    }
    let saved = if row.turn == 1 {
        lifetime()
    } else {
        turn_caps()
    };
    let reservation = match reserve(saved, row.available) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    if row.available != reservation.available || row.remaining != reservation.remaining {
        return "work-chain reservation conservation mismatch";
    }
    if row.turn == 1 {
        if row.id != row.chain || row.parent_id != "" || row.parent_version != "" || row.parent_digest != "" {
            return "invalid work-chain root lineage";
        }
    } else {
        if row.id == row.chain || row.parent_id != row.chain || char_count(row.parent_version) == 0
            || len(row.parent_version) > 512 || char_count(row.parent_digest) != 64 {
            return "invalid work-chain successor lineage";
        }
        if row.available != turn_caps() || row.remaining != zero() {
            return "work-chain second-turn allowance mismatch";
        }
    }
    if row.phase == "admitted" {
        if row.work != None() || row.reserved != turn_caps() {
            return "invalid work-chain admitted reservation";
        }
    } else {
        let work = match row.work {
            Some(value) => value,
            None() => {
                return "completed edit work missing from chain";
            }
        };
        let captured = match validate(work) {
            Ok(value) => value,
            Err(error) => {
                return error;
            }
        };
        if work.phase != row.phase || captured.binding.id != row.id
            || captured.binding.workspace != row.workspace || captured.binding.region != row.region
            || captured.binding.path != row.path || captured.evidence.request != row.request
            || captured.evidence.allowed != row.allowed {
            return "work-chain captured work binding mismatch";
        }
        let expected = if row.phase == "summary-confirmed" {
            zero()
        } else {
            summary_reservation()
        };
        if row.reserved != expected {
            return "invalid work-chain final reservation";
        }
    }
    var decoded: usize = 0;
    @limits([Iterations(10)]) for field in [
        row.phase,
        row.chain,
        row.id,
        row.workspace,
        row.region,
        row.path,
        row.request,
        row.parent_id,
        row.parent_version,
        row.parent_digest
    ] {
        decoded = decoded + len(field);
    }
    @limits([Iterations(2)]) for field in row.allowed {
        decoded = decoded + len(field);
    }
    // Count the separately bounded decoded projection rather than its escaped body.
    // The fixed scalar/counter overhead is conservatively included as 512 bytes.
    decoded = decoded + 512;
    match row.work {
        Some(value) => {
            let binding = value.binding;
            @limits([Iterations(10)]) for field in [
                value.phase,
                binding.id,
                binding.workspace,
                binding.region,
                binding.path,
                binding.request_digest,
                binding.before_digest,
                binding.after_digest,
                from_usize(binding.before_bytes),
                from_usize(binding.after_bytes)
            ] {
                decoded = decoded + len(field);
            }
            decoded = decoded + 12288;
        }
        None() => (),
    }
    if decoded > context_bytes() {
        return "work-chain decoded metadata plus work exceeds 33554432 bytes";
    }
    return match serialized(row) {
        Ok(_) => "",
        Err(error) => error
    };
}

public flow fingerprint(row: Record) -> Result<string, string> {
    let invalid = work_chain_validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    let encoded = match serialized(row) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return digest(encoded);
}

flow initial_format(
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps,
    format: i32
) -> Result<Record, string> {
    let reservation = match reserve(lifetime(), policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let row = Record {
        format,
        phase = "admitted",
        chain = id,
        turn = 1,
        id,
        workspace,
        region = "nomo.tools.edit_file.EditableRoot",
        path,
        request,
        allowed,
        parent_id = "",
        parent_version = "",
        parent_digest = "",
        maximum = lifetime(),
        available = reservation.available,
        remaining = reservation.remaining,
        reserved = turn_caps(),
        work = None()
    };
    let invalid = work_chain_validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(row);
}

public flow initial(
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps
) -> Result<Record, string> {
    return initial_format(id, workspace, path, request, allowed, policy, 2);
}

public flow initial_user_context(
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps
) -> Result<Record, string> {
    return initial_format(id, workspace, path, request, allowed, policy, 3);
}

public flow successor(
    parent: Record,
    parent_version: string,
    id: string,
    request: string,
    allowed: Array<string>,
    policy: Caps
) -> Result<Record, string> {
    let invalid = work_chain_validate(parent);
    if invalid != "" {
        return Err(invalid);
    }
    if parent.format != 2 {
        return Err("user-context work cannot continue or resume");
    }
    if parent.turn != 1 || parent.phase != "summary-confirmed" {
        return Err("only a confirmed first v2 turn can continue; no third turn or v1 upgrade");
    }
    let reservation = match reserve(parent.remaining, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let proof = match fingerprint(parent) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let row = parent {
        format = 2,
        phase = "admitted",
        turn = 2,
        id,
        request,
        allowed,
        parent_id = parent.id,
        parent_version,
        parent_digest = proof,
        available = reservation.available,
        remaining = reservation.remaining,
        reserved = turn_caps(),
        work = None()
    };
    let error = work_chain_validate(row);
    if error != "" {
        return Err(error);
    }
    if allowed != parent.allowed {
        return Err("work-chain allowed-file binding changed");
    }
    return Ok(row);
}

public flow linked(parent: Record, parent_version: string, child: Record) -> string {
    if parent.format != 2 || child.format != 2 {
        return "user-context work cannot have a successor";
    }
    let invalid = work_chain_validate(parent);
    if invalid != "" {
        return invalid;
    }
    let invalid_child = work_chain_validate(child);
    if invalid_child != "" {
        return invalid_child;
    }
    if parent.turn != 1 || parent.phase != "summary-confirmed" || child.turn != 2
        || child.parent_id != parent.id || child.chain != parent.chain || child.workspace != parent.workspace
        || child.region != parent.region || child.path != parent.path || child.allowed != parent.allowed
        || child.parent_version != parent_version || child.id == parent.id {
        return "work-chain parent or workspace binding mismatch";
    }
    let proof = match fingerprint(parent) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    if child.parent_digest != proof {
        return "work-chain parent digest changed";
    }
    let reserved = match reserve(parent.remaining, child.available) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    if child.available != reserved.available || child.remaining != reserved.remaining {
        return "work-chain saved allowance changed";
    }
    let previous = match parent.work {
        Some(value) => value,
        None() => {
            return "confirmed parent work missing";
        }
    };
    let prior = match validate(previous) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    match child.work {
        Some(value) => {
            let current = match validate(value) {
                Ok(item) => item,
                Err(error) => {
                    return error;
                }
            };
            if current.before != prior.after {
                return "work-chain original differs from captured parent result";
            }
        }
        None() => (),
    }
    return "";
}

public flow publish_partial(row: Record, work: work_record_Record) -> Result<Record, string> {
    let invalid = work_chain_validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    if row.phase != "admitted" || work.phase != "summary-unconfirmed" {
        return Err("chain partial requires its original admission and confirmed edit");
    }
    let result = row {
        phase = "summary-unconfirmed",
        reserved = summary_reservation(),
        work = Some(work)
    };
    let error = work_chain_validate(result);
    if error != "" {
        return Err(error);
    }
    return Ok(result);
}

public flow confirm(row: Record, summary: string) -> Result<Record, string> {
    let invalid = work_chain_validate(row);
    if invalid != "" {
        return Err(invalid);
    }
    if row.phase != "summary-unconfirmed" {
        return Err("chain summary requires an unconfirmed work record");
    }
    let work = match row.work {
        Some(value) => value,
        None() => {
            return Err("chain partial work missing");
        }
    };
    let completed = match work_confirm(work, summary) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let result = row {
        phase = "summary-confirmed",
        reserved = zero(),
        work = Some(completed)
    };
    let error = work_chain_validate(result);
    if error != "" {
        return Err(error);
    }
    return Ok(result);
}

public type CapturedJournal = {
    format: i32,
    chain: string,
    turn: i32,
    phase: string,
    binding: Binding
};

public flow invalid(row: CapturedJournal) -> string {
    if row.format != 2 || (row.turn != 1 && row.turn != 2) || (
        row.phase != "intent"
            && row.phase != "completed"
    ) {
        return "invalid v2 edit journal format, turn or phase";
    }
    let binding = binding_error(row.binding);
    if binding != "" {
        return binding;
    }
    let chain = selector_error(row.chain, row.binding.workspace, row.binding.path);
    if chain != "" {
        return chain;
    }
    if (row.turn == 1 && row.chain != row.binding.id) || (row.turn == 2 && row.chain == row.binding.id) {
        return "v2 edit journal chain identity mismatch";
    }
    return "";
}

// One cohesive replaceable dependency: the complete configured fixed-slot observation.
public enum ObservationPass {
    First,
    Recheck
}

// Copied observations only; these values are never receipts or execution grants.
public type ObservedRow = {
    key: string,
    version: string,
    value: Record
};

public type ObservedJournal = {
    key: string,
    version: string,
    value: CapturedJournal
};

public type Snapshot = {
    root: Option<ObservedRow>,
    child: Option<ObservedRow>,
    root_journal: Option<ObservedJournal>,
    child_journal: Option<ObservedJournal>
};

public enum Selector {
    All,
    Exact(string),
    Latest,
    Parent
}

public flow journal_error(row: Record, journal: Option<CapturedJournal>) -> string {
    match journal {
        Some(value) => {
            let invalid = invalid(value);
            if invalid != "" {
                return invalid;
            }
            if value.chain != row.chain || value.turn != row.turn || value.binding.id != row.id
                || value.binding.workspace != row.workspace || value.binding.path != row.path {
                return "v2 discovery journal binding mismatch";
            }
            match row.work {
                Some(work) => {
                    if value.phase != "completed" || !same_binding(value.binding, work.binding) {
                        return "v2 work and completed edit journal differ";
                    }
                },
                None() => (),
            }
        }
        None() => {
            if row.work != None() {
                return "v2 work has no confirmed edit journal";
            }
        },
    }
    return "";
}

flow journal_row(row: Record, observed: Option<ObservedJournal>) -> string {
    let key = if row.turn == 1 {
        "turn:1"
    } else {
        "turn:2"
    };
    let selected = match observed {
        Some(value) => {
            if value.key != key {
                return "v2 discovery journal slot mismatch";
            }
            Some(value.value)
        },
        None() => None(),
    };
    return journal_error(row, selected);
}

public flow work_chain_selection_validate(view: Snapshot, workspace: string, path: string) -> string {
    let binding = selector_error("discovery", workspace, path);
    if binding != "" {
        return binding;
    }
    let root = match view.root {
        Some(value) => value,
        None() => {
            if view.child != None() || view.root_journal != None() || view.child_journal != None() {
                return "v2 discovery orphan slot or journal";
            }
            return "";
        }
    };
    let invalid = work_chain_validate(root.value);
    if invalid != "" {
        return invalid;
    }
    if root.value.format == 3 && (view.child != None() || view.child_journal != None()) {
        return "user-context work cannot have a successor or second journal";
    }
    if root.key != "turn:1" || root.value.turn != 1 {
        return "v2 discovery root slot mismatch";
    }
    if root.value.workspace != workspace || root.value.path != path {
        return "v2 discovery workspace or path mismatch";
    }
    let root_edit = journal_row(root.value, view.root_journal);
    if root_edit != "" {
        return root_edit;
    }
    match view.child {
        Some(child) => {
            if child.key != "turn:2" || child.value.turn != 2 {
                return "v2 discovery child slot mismatch";
            }
            let invalid = linked(root.value, root.version, child.value);
            if invalid != "" {
                return invalid;
            }
            let edit = journal_row(child.value, view.child_journal);
            if edit != "" {
                return edit;
            }
        }
        None() => {
            if view.child_journal != None() {
                return "v2 discovery orphan second journal; slot cannot be reused";
            }
        },
    }
    return "";
}

public flow eligible(view: Snapshot, workspace: string, path: string) -> bool {
    if work_chain_selection_validate(view, workspace, path) != "" {
        return false;
    }
    return match view.root {
        Some(value) => value.value.format == 2 && value.value.phase == "summary-confirmed"
            && view.child == None() && view.child_journal == None(),
        None() => false,
    };
}

public flow select(view: Snapshot, workspace: string, path: string, selector: Selector) -> Result<
    Array<Record>,
    string
> {
    let invalid = work_chain_selection_validate(view, workspace, path);
    if invalid != "" {
        return Err(invalid);
    }
    var rows: Array<Record> = [];
    match view.root {
        Some(value) => {
            rows = rows.push(value.value);
        }
        None() => (),
    }
    match view.child {
        Some(value) => {
            rows = rows.push(value.value);
        }
        None() => (),
    }
    return match selector {
        Selector.All => Ok(rows),
        Selector.Latest => if rows.len() == 0 {
            Ok([])
        } else {
            Ok([rows[rows.len() - 1]])
        },
        Selector.Exact(id) => {
            let error = selector_error(id, workspace, path);
            if error != "" {
                return Err(error);
            }
            if rows.len() == 0 {
                return Ok([]);
            }
            @limits([Iterations(2)]) for row in rows {
                if row.id == id {
                    return Ok([row]);
                }
            }
            Err("v2 discovery selected ID missing")
        }
        Selector.Parent => if eligible(view, workspace, path) {
            Ok([rows[0]])
        } else {
            Err("latest continuation requires a confirmed first turn and unused second slot; no fallback or replay")
        },
    };
}

public flow journal_phase(view: Snapshot, turn: i32) -> string {
    if turn != 1 && turn != 2 {
        return "invalid";
    }
    let selected = if turn == 1 {
        view.root_journal
    } else {
        view.child_journal
    };
    return match selected {
        Some(value) => value.value.phase,
        None() => "missing"
    };
}

public flow consistent(before: Snapshot, after: Snapshot) -> string {
    return if before == after {
        ""
    } else {
        "v2 discovery changed during repeated reads; no selection or continuation"
    };
}

public type WorkRequest = {
    selected: editing_Selector,
    request: string,
    allowed: Array<string>,
    cap: Caps
};

public type ContinueRequest = {
    parent: string,
    work: WorkRequest
};

public enum TurnRequest {
    New(WorkRequest),
    Continue(ContinueRequest)
}

public type WorkStop = {
    state: Ledger,
    error: string
};

public enum WorkOutcome {
    Completed,
    Stopped(WorkStop)
}

public type CapturedShow = {
    row: Record,
    journal: Option<CapturedJournal>
};
