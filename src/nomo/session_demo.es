module nomo.session_demo;

import std.io.println;
import std.collections.len as count;
import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import std.agent.session.Conversation;
import nomo.session_cli_args.{parse, Options};
import nomo.session_cli.run_session;
import nomo.store_record.session_key;
import nomo.metadata_store.read as read_metadata;

type Claim = { format: i32, phase: string, session_id: string, save_id: string, binding: string,
    maximum: i32, budget: i32 };
alias Schema = MemoryRegion<{ Claims: Store<string, Claim> }>;
let Demo = std.memory.region<Schema>(stable_id = "nomo-session-demo-v1", store = "session-demo");

flow claim(options: Options, phase: string) -> Claim {
    return Claim { format = 1, phase = phase, session_id = options.session_id, save_id = options.save_id,
        binding = options.binding, maximum = options.maximum, budget = options.budget };
}

// This marker serializes one admitted demo. It is not proof that an arbitrary
// database was unused; an exclusively created directory/single writer is required.
flow write_claim(value: Claim, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>] {
    let intent = prepare_put(Demo.Claims, "single-demo", value, condition);
    let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("demo initialization unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("demo initialization refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "single-demo" || receipt.target.region != "nomo-session-demo-v1" ||
        receipt.target.store != ["Claims"] { return Err("demo receipt mismatch"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite demo receipt required"); }
    let committed = match receipt.change { MemoryWriteChange.Written(version) => version, _ => { return Err("demo write receipt required"); } };
    let observed = match get_entry(Demo.Claims, "single-demo") {
        Some(entry) => entry, None() => { return Err("demo claim missing after commit"); }
    };
    if observed.key != "single-demo" || observed.value != value || observed.version.opaque != committed.opaque {
        return Err("demo claim readback mismatch");
    }
    return Ok(committed);
}

flow initialize(options: Options) -> Result<bool, string> ![Memory, Error<StorageError>] {
    match get_entry(Demo.Claims, "single-demo") {
        Some(_) => { return Err("demo already claimed; no reinitialization or repair"); } None() => {}
    }
    match read_metadata(options.session_id) {
        Some(_) => { return Err("demo session metadata already exists"); } None() => {}
    }
    let version = match write_claim(claim(options, "claimed"), Missing) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    // The only initialization Resolve. A lost acknowledgement leaves the claim
    // fail-closed; no caller can repeat this step through this entry.
    let history = Conversation.load(SessionConfig.continue_or_new(session_key(options.session_id, options.save_id)));
    let terminal = match history.cursor { None() => true, _ => false };
    let no_summary = match history.summary { None() => true, _ => false };
    if count(history.messages) != 0 || !terminal || !no_summary { return Err("demo namespace is not empty"); }
    let ready = match write_claim(claim(options, "ready"), Match(version)) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if ready.opaque == version.opaque { return Err("demo ready version did not change"); }
    return Ok(true);
}

flow ready(options: Options) -> Result<bool, string> {
    let entry = match get_entry(Demo.Claims, "single-demo") {
        Some(value) => value, None() => { return Err("demo is not initialized"); }
    };
    let owner = entry.value;
    if entry.key != "single-demo" || owner.format != 1 || owner.phase != "ready" {
        return Err("demo initialization is incomplete; no retry or repair");
    }
    if owner.session_id != options.session_id || owner.save_id != options.save_id || owner.binding != options.binding {
        return Err("demo identity or binding mismatch");
    }
    if owner.maximum < 1 || owner.maximum > 16 || owner.budget < 1 || owner.budget > 16 {
        return Err("invalid demo cap claim");
    }
    if options.verb == "save" && (owner.maximum != options.maximum || owner.budget != options.budget) {
        return Err("demo save caps differ from initialization");
    }
    if options.verb == "save" {
        match read_metadata(options.session_id) {
            Some(_) => { return Err("session metadata already exists"); } None() => {}
        }
    }
    // Show caps remain independent caller input. The accepted validator may
    // narrow saved caps, never replenish spent budget or use marker authority.
    return Ok(true);
}

// Unique opt-in handler; the root default stub remains a separate entry.
public flow demo(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    if count(args) > 13 { println("REFUSED expected bounded demo arguments"); return 2; }
    var initializing = false;
    var normalized: Array<string> = [];
    var index: usize = 0;
    for argument in args limit Iterations(14) {
        if index == 0 && argument == "init" { initializing = true; normalized = normalized.push("show"); }
        else { normalized = normalized.push(argument); }
        index = index + 1;
    }
    let options = match parse(normalized) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 2; }
    };
    if options.verb == "help" {
        println("Dedicated fresh Docker demo only; exclusive directory creation and one writer are required.");
        println("init|show --session ID --save SAVE_ID --binding EXPECTED [--steps 1..16] [--budget 1..16]");
        println("save --session ID --save SAVE_ID --binding EXPECTED --input TEXT [--steps 1..16] [--budget 1..16]");
        println("Save caps must match init. Show is data-only; no resume, repair, reinitialization or arbitrary-store adoption.");
        return 0;
    }
    let admitted = if initializing { initialize(options) } else { ready(options) };
    match admitted { Err(error) => { println("REFUSED " + error); return 3; } Ok(_) => {} }
    if initializing { println("INITIALIZED demo namespace; one save permitted"); return 0; }
    return run_session(args);
}
