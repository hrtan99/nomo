module nomo.session_demo;

import std.io.println;
import std.collections.len as count;
import std.memory.{Missing, Match};
import std.agent.session.Conversation;
import nomo.session_cli_args.{parse, Options};
import nomo.session_cli.run_session;
import nomo.store_record.session_key;
import nomo.metadata_store.read as read_metadata;
import nomo.stub_snapshot.caps;
import nomo.continuation_args.parse_continue;
import nomo.session_continue.run_continue;
import nomo.demo_claim.{Claim, read_claim, write_claim};

flow claim(options: Options, phase: string) -> Claim {
    return Claim { format = 1, phase = phase, session_id = options.session_id, save_id = options.save_id,
        binding = options.binding, maximum = options.maximum, budget = options.budget };
}

flow initialize(options: Options) -> Result<bool, string> ![Memory, Error<StorageError>] {
    match read_claim() {
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

flow owned(options: Options) -> Result<Claim, string> {
    let entry = match read_claim() {
        Some(value) => value, None() => { return Err("demo is not initialized"); }
    };
    let owner = entry.value;
    if entry.key != "single-demo" || owner.format != 1 ||
        (owner.phase != "ready" && !(options.verb == "show" && owner.phase == "continue-claimed")) {
        return Err("demo initialization is incomplete; no retry or repair");
    }
    if owner.session_id != options.session_id || owner.binding != options.binding {
        return Err("demo identity or binding mismatch");
    }
    if owner.maximum < 1 || owner.maximum > 16 || owner.budget < 1 || owner.budget > 16 {
        return Err("invalid demo cap claim");
    }
    return Ok(owner);
}

flow ready(options: Options) -> Result<bool, string> {
    let owner = match owned(options) { Ok(value) => value, Err(error) => { return Err(error); } };
    if options.verb == "save" && owner.save_id != options.save_id { return Err("demo identity or binding mismatch"); }
    if options.verb == "save" && (owner.maximum != options.maximum || owner.budget != options.budget) {
        return Err("demo save caps differ from initialization");
    }
    if options.verb == "save" {
        match read_metadata(options.session_id) {
            Some(_) => { return Err("session metadata already exists"); } None() => {}
        }
    } else {
        let row = match read_metadata(options.session_id) { Some(value) => value.value, None() => { return Err("session metadata missing"); } };
        if row.format != 1 || row.phase != "published" || row.save_id != options.save_id ||
            row.snapshot.session_id != owner.session_id || row.snapshot.binding != owner.binding || row.snapshot.mode != "stub" ||
            row.snapshot.original_caps != caps(owner.maximum, owner.budget) ||
            (row.snapshot.generation != 0 && row.snapshot.generation != 1) ||
            (row.snapshot.generation == 0 && (row.save_id != owner.save_id || owner.phase != "ready")) ||
            (row.snapshot.generation == 1 && (row.save_id == owner.save_id || owner.phase != "continue-claimed")) {
            return Err("current checkpoint is not associated with demo claim; no historical show");
        }
    }
    // Show caps remain independent caller input. The accepted validator may
    // narrow saved caps, never replenish spent budget or use marker authority.
    return Ok(true);
}

// Unique opt-in handler; the root default stub remains a separate entry.
public flow demo(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    if count(args) > 0 && args[0] == "continue" {
        let options = match parse_continue(args) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 2; } };
        let owner = match owned(options.turn) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; } };
        if options.turn.save_id != owner.save_id { println("REFUSED predecessor differs from initial demo claim"); return 3; }
        let current = match read_metadata(owner.session_id) { Some(value) => value.value, None() => { println("REFUSED session metadata missing"); return 3; } };
        if current.snapshot.original_caps != caps(owner.maximum, owner.budget) { println("REFUSED original caps differ from demo claim"); return 3; }
        return run_continue(options);
    }
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
        println("continue --session ID --save PRIOR --generation 0 --next-save NEXT --binding EXPECTED --input TEXT [--steps 1..16] [--budget 1..16]");
        println("Save caps must match init. One stub successor only; show is current data-only, no repair or arbitrary-store adoption.");
        return 0;
    }
    let admitted = if initializing { initialize(options) } else { ready(options) };
    match admitted { Err(error) => { println("REFUSED " + error); return 3; } Ok(_) => {} }
    if initializing { println("INITIALIZED demo namespace; one save permitted"); return 0; }
    return run_session(args);
}
