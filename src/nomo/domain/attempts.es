module nomo.domain.attempts;

import nomo.native.lifecycle.Attempt;

public enum Transition { Dispatch, Return, Complete, CloseUnknown }

public flow unresolved(value: Attempt) -> bool {
    return value.phase != "completed" && value.phase != "closed_unknown";
}

public flow next_phase(value: Attempt, step: Transition, result_complete: bool) -> string {
    return match step {
        Transition.Dispatch => {
            if value.phase != "prepared" { abort("attempt dispatch has already been recorded"); }
            "dispatching"
        },
        Transition.Return => {
            if value.phase != "dispatching" { abort("attempt is not awaiting a result"); }
            "returned"
        },
        Transition.Complete => {
            if value.result_event < 0 || !result_complete { abort("attempt has no complete saved result"); }
            "completed"
        },
        Transition.CloseUnknown => "closed_unknown"
    };
}
