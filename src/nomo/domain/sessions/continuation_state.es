module nomo.domain.sessions.continuation_state;

import std.text.{char_count as len, trim};
import nomo.domain.text.text.input_error;
import nomo.domain.conversation.state.capacity_error;
import nomo.session.session_state.Snapshot;
import nomo.domain.sessions.session_state.{Request, Projection, validate};
import nomo.session.store_record.Record;
import nomo.domain.sessions.store_record.pending;

public type Admission = { prior: Projection, reserved: i32 };

public flow plan(saved: Snapshot, requested: Request, generation: i32, input: string) -> Result<Admission, string> {
    let prior = match validate(saved, requested) { Ok(value) => value, Err(error) => { return Err(error); } };
    if generation != 0 || prior.generation != generation || prior.mode != "stub" { return Err("unsupported or stale checkpoint generation"); }
    if prior.disposition != "validated" || prior.history.stopped { return Err("session stopped or recovery required; no continuation"); }
    let invalid = input_error(input);
    if invalid != "" { return Err(invalid); }
    let size = len(trim(input));
    var characters = 4 * size + 32;
    if characters < size + 1040 { characters = size + 1040; }
    let full = capacity_error(prior.history, 4, characters);
    if full != "" { return Err(full); }
    // validate bounded all counters first. These subtractions/additions cannot overflow.
    var bound = prior.caps.steps - prior.history.spent;
    if bound > prior.caps.turn_steps { bound = prior.caps.turn_steps; }
    if bound > 3 { bound = 3; }
    if bound <= 0 { return Err("session step budget exhausted"); }
    return Ok(Admission { prior, reserved = prior.history.spent + bound });
}

// Same typed record shape, explicit non-checkpoint phase. The immutable demo claim
// binds the predecessor ID; this row binds generation 0 and the distinct next key.
// Reserved spending is a high-water mark, never measured completed work.
public flow continuing(admitted: Admission, next_save: string) -> Record {
    let prior = admitted.prior;
    let reserved = Snapshot { format = 1, session_id = prior.session_id, generation = prior.generation,
        mode = prior.mode, binding = prior.binding, lifecycle = "recovery-required",
        history = prior.history { spent = admitted.reserved, stopped = true },
        references = prior.references, operations = prior.operations, original_caps = prior.original_caps,
        current_caps = prior.caps, ledger = prior.ledger };
    let row = pending(reserved, next_save);
    return row { phase = "continuing" };
}
