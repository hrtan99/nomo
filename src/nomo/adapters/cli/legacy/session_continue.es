module nomo.adapters.cli.legacy.session_continue;

import std.io.println;
import std.text.from_i32;
import std.agent.session.Conversation;
import nomo.adapters.cli.arguments.continuation_args.ContinueOptions;
import nomo.domain.sessions.continuation_state.{plan, continuing};
import nomo.domain.sessions.session_state.{Request, validate};
import nomo.adapters.storage.legacy.session_store.publish_snapshot;
import nomo.domain.sessions.stub_snapshot.{caps, successor};
import nomo.adapters.storage.legacy.metadata_store.{read, publish};
import nomo.domain.sessions.store_record.{session_key, restore};
import nomo.adapters.storage.legacy.history_store.{load, empty};
import nomo.bootstrap.harness.stub.turn;
import nomo.domain.sessions.session_display.display;
import std.memory.WriteCondition;
import nomo.adapters.storage.legacy.demo_claim.{read_claim, write_claim};

public flow run_continue(options: ContinueOptions) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>, Error<BudgetExceeded>] {
    let input = options.turn;
    let before = match read(input.session_id) { Some(value) => value, None() => { println("REFUSED session metadata missing"); return 3; } };
    let row = before.value;
    if row.format != 1 || row.phase != "published" || row.save_id != input.save_id ||
        row.snapshot.session_id != input.session_id || row.session_key != session_key(input.session_id, input.save_id) {
        println("REFUSED current checkpoint identity or phase mismatch; no retry"); return 3;
    }
    let body = match load(row.session_key) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; } };
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
    let successor = match successor(completed.state, admitted.prior, admitted.reserved, completed.status) {
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
