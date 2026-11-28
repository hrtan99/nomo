module nomo.adapters.cli.state;

import nomo.adapters.cli.session_input.{ContinueOptions, Options, parse_continue, session_cli_args_parse};
import nomo.adapters.storage.session_records.{
    empty,
    history_store_load,
    publish,
    publish_snapshot,
    read,
    read_claim,
    reload,
    save,
    write_claim
};
import nomo.bootstrap.harness.turn;
import nomo.domain.conversation.fresh;
import nomo.domain.sessions.state.{
    Projection,
    Request,
    caps,
    continuing,
    plan,
    restore,
    session_key,
    snapshot,
    successor as state_successor,
    validate
};
import nomo.domain.wire.{ascii_json, encode};
import nomo.session.demo_claim.Claim;
import nomo.session.session_state.Snapshot;
import std.agent.session.Conversation;
import std.io.println;
import std.memory.{Missing, WriteCondition};
import std.text.from_i32;

// Opt-in entry only. Initialize the fresh project-owned demo store explicitly.
// show is a data projection, never resume, dispatch, repair or ID-only discovery.
public flow run_session(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
    let options = match session_cli_args_parse(args) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 2; }
    };
    if options.verb == "help" {
        println("Opt-in stub session storage; initialize a fresh project-owned demo store first.");
        println("save --session ID --save SAVE_ID --binding EXPECTED --input TEXT [--steps 1..16] [--budget 1..16]");
        println("show --session ID --save SAVE_ID --binding EXPECTED [--steps 1..16] [--budget 1..16]");
        println("Defaults: steps 3, budget 16. Show is read-only data, not resumed execution or trusted workspace ownership.");
        return 0;
    }
    let requested = Request { session_id = options.session_id, mode = "stub", binding = options.binding,
        caps = caps(options.maximum, options.budget) };
    var turn_status: i32 = 0;
    let result = if options.verb == "show" { reload(requested, options.save_id) } else {
        let completed = turn(options.input, options.maximum, options.budget, fresh());
        turn_status = completed.status;
        let saved = match snapshot(completed.state, options.session_id, options.binding, options.maximum, options.budget) {
            Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
        };
        save(saved, requested, options.save_id)
    };
    let projection = match result {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
    };
    let output = match display(projection) {
        Ok(value) => value, Err(error) => {
            if options.verb == "save" { println("STORED_DISPLAY_FAILED; do not retry: " + error); }
            else { println("REFUSED " + error); }
            return 3;
        }
    };
    // This confirms storage/data validation, not successful work or effect authority.
    if options.verb == "save" { println("SAVED turn_status=" + from_i32(turn_status) + " " + output); }
    else { println("SHOW " + output); }
    return 0;
}

public flow run_continue(options: ContinueOptions) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
    let input = options.turn;
    let before = match read(input.session_id) { Some(value) => value, None() => { println("REFUSED session metadata missing"); return 3; } };
    let row = before.value;
    if row.format != 1 || row.phase != "published" || row.save_id != input.save_id ||
        row.snapshot.session_id != input.session_id || row.session_key != session_key(input.session_id, input.save_id) {
        println("REFUSED current checkpoint identity or phase mismatch; no retry"); return 3;
    }
    let body = match history_store_load(row.session_key) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; } };
    let saved = match restore(row, body) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; } };
    let requested = Request { session_id = input.session_id, mode = "stub", binding = input.binding, caps = caps(input.maximum, input.budget) };
    let admitted = match plan(saved, requested, options.generation, input.input) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
    };
    let checked = match read(input.session_id) { Some(value) => value, None() => { println("REFUSED metadata disappeared"); return 3; } };
    if checked.value != row || checked.version.opaque != before.version.opaque { println("REFUSED predecessor changed"); return 3; }
    let owner = match read_claim() { Some(value) => value, None() => { println("REFUSED demo claim missing"); return 3; } };
    let claim = owner.value;
    if owner.key != "single-demo" || claim.format != 1 || claim.phase != "ready" || claim.session_id != input.session_id ||
        claim.save_id != input.save_id || claim.binding != input.binding || caps(claim.maximum, claim.budget) != saved.original_caps {
        println("REFUSED predecessor not associated with ready demo claim"); return 3;
    }
    let consumed = claim { phase = "continue-claimed" };
    // A one-shot fence blocks restart even if the following metadata CAS never commits.
    let fenced = match write_claim(consumed, WriteCondition.Match(owner.version)) {
        Ok(value) => value, Err(error) => { println("REFUSED continuation fence: " + error); return 3; }
    };
    if fenced.opaque == owner.version.opaque { println("REFUSED continuation fence version did not change"); return 3; }
    let admission = continuing(admitted, options.next_save);
    // Actual-version checked durable CAS/readback BEFORE Resolve, turn or Append.
    let version = match publish(admission, before.version) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
    };
    let history = Conversation.load(SessionConfig.continue_or_new(admission.session_key));
    let terminal = match history.cursor { None() => true, _ => false };
    let no_summary = match history.summary { None() => true, _ => false };
    if history.messages.len() != 0 || !terminal || !no_summary || !empty(admission.session_key) {
        println("REFUSED successor namespace is not empty; admission retained"); return 3;
    }
    let completed = turn(input.input, admitted.prior.caps.turn_steps, admitted.prior.caps.steps, admitted.prior.history);
    let successor = match state_successor(completed.state, admitted.prior, admitted.reserved, completed.status) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
    };
    match publish_snapshot(successor, options.next_save, admission, version, true) {
        Ok(_) => (), Err(error) => { println("REFUSED " + error); return 3; }
    }
    let projection = match validate(successor, requested) {
        Ok(value) => value, Err(error) => { println("STORED_DISPLAY_FAILED; do not retry: " + error); return 3; }
    };
    let output = match display(projection) {
        Ok(value) => value, Err(error) => { println("STORED_DISPLAY_FAILED; do not retry: " + error); return 3; }
    };
    println("SAVED turn_status=" + from_i32(completed.status) + " " + output);
    return 0;
}

flow claim(options: Options, phase: string) -> Claim {
    return Claim { format = 1, phase, session_id = options.session_id, save_id = options.save_id,
        binding = options.binding, maximum = options.maximum, budget = options.budget };
}

flow initialize(options: Options) -> Result<bool, string> ![Memory, Error<StorageError>] {
    match read_claim() {
        Some(_) => { return Err("demo already claimed; no reinitialization or repair"); } None() => (),
    }
    match read(options.session_id) {
        Some(_) => { return Err("demo session metadata already exists"); } None() => (),
    }
    let version = match write_claim(claim(options, "claimed"), Missing) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    // The only initialization Resolve. A lost acknowledgement leaves the claim
    // fail-closed; no caller can repeat this step through this entry.
    let history = Conversation.load(SessionConfig.continue_or_new(session_key(options.session_id, options.save_id)));
    let terminal = match history.cursor { None() => true, _ => false };
    let no_summary = match history.summary { None() => true, _ => false };
    if history.messages.len() != 0 || !terminal || !no_summary { return Err("demo namespace is not empty"); }
    let ready = match write_claim(claim(options, "ready"), WriteCondition.Match(version)) {
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
        match read(options.session_id) {
            Some(_) => { return Err("session metadata already exists"); } None() => (),
        }
    } else {
        let row = match read(options.session_id) { Some(value) => value.value, None() => { return Err("session metadata missing"); } };
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
public flow demo(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
    if args.len() > 0 && args[0] == "continue" {
        let options = match parse_continue(args) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 2; } };
        let owner = match owned(options.turn) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; } };
        if options.turn.save_id != owner.save_id { println("REFUSED predecessor differs from initial demo claim"); return 3; }
        let current = match read(owner.session_id) { Some(value) => value.value, None() => { println("REFUSED session metadata missing"); return 3; } };
        if current.snapshot.original_caps != caps(owner.maximum, owner.budget) { println("REFUSED original caps differ from demo claim"); return 3; }
        return run_continue(options);
    }
    if args.len() > 13 { println("REFUSED expected bounded demo arguments"); return 2; }
    var initializing = false;
    var normalized: Array<string> = [];
    var index: usize = 0;
    @limits([Iterations(14)]) for argument in args {
        if index == 0 && argument == "init" { initializing = true; normalized = normalized.push("show"); }
        else { normalized = normalized.push(argument); }
        index = index + 1;
    }
    let options = match session_cli_args_parse(normalized) {
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
    match admitted { Err(error) => { println("REFUSED " + error); return 3; } Ok(_) => (), }
    if initializing { println("INITIALIZED demo namespace; one save permitted"); return 0; }
    return run_session(args);
}

public flow display(projection: Projection) -> Result<string, string> {
    var lifecycle = "active";
    if projection.disposition == "recovery-required" { lifecycle = "recovery-required"; }
    else if projection.history.stopped { lifecycle = "stopped"; }
    let saved = Snapshot { format = 1, session_id = projection.session_id, generation = projection.generation,
        mode = projection.mode, binding = projection.binding, lifecycle, history = projection.history,
        references = projection.references, operations = projection.operations, original_caps = projection.original_caps,
        current_caps = projection.caps, ledger = projection.ledger };
    let requested = Request { session_id = projection.session_id, mode = projection.mode,
        binding = projection.binding, caps = projection.caps };
    match validate(saved, requested) {
        Ok(checked) => { if checked != projection { return Err("inconsistent display projection"); } },
        Err(_) => { return Err("invalid display projection"); }
    }
    let json = match encode(projection, "display conversion failed", "display JSON failed") { Ok(value) => value, Err(error) => { return Err(error); } };
    return ascii_json(json, 131072, "display encoded limit exceeded", "display output limit exceeded");
}
