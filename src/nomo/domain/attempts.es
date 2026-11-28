module nomo.domain.attempts;

import nomo.domain.wire.{value as json_value, fields};
import std.json.JsonValue;

public enum AttemptKind {
    Coding,
    Summary,
    Command,
    Observation,
    Export
}

impl AttemptKind {
    public flow wire(self) -> string ![] {
        return match self {
            AttemptKind.Coding => "coding",
            AttemptKind.Summary => "summary",
            AttemptKind.Command => "command",
            AttemptKind.Observation => "observation",
            AttemptKind.Export => "export"
        };
    }

    public flow parse(raw: string) -> AttemptKind ![] {
        return match raw {
            "coding" => AttemptKind.Coding,
            "summary" => AttemptKind.Summary,
            "command" => AttemptKind.Command,
            "observation" => AttemptKind.Observation,
            "export" => AttemptKind.Export,
            _ => abort("invalid AttemptKind spelling: " + raw)
        };
    }
}

public enum AttemptPhase {
    Prepared,
    Dispatching,
    Returned,
    Completed,
    ClosedUnknown
}

impl AttemptPhase {
    public flow wire(self) -> string ![] {
        return match self {
            AttemptPhase.Prepared => "prepared",
            AttemptPhase.Dispatching => "dispatching",
            AttemptPhase.Returned => "returned",
            AttemptPhase.Completed => "completed",
            AttemptPhase.ClosedUnknown => "closed_unknown"
        };
    }

    public flow parse(raw: string) -> AttemptPhase ![] {
        return match raw {
            "prepared" => AttemptPhase.Prepared,
            "dispatching" => AttemptPhase.Dispatching,
            "returned" => AttemptPhase.Returned,
            "completed" => AttemptPhase.Completed,
            "closed_unknown" => AttemptPhase.ClosedUnknown,
            _ => abort("invalid AttemptPhase spelling: " + raw)
        };
    }
}

public enum Transition {
    Dispatch,
    Return,
    Complete,
    CloseUnknown
}

public flow unresolved(value: ExecutionAttempt) -> bool {
    return value.phase != AttemptPhase.Completed && value.phase != AttemptPhase.ClosedUnknown;
}

public flow next_phase(value: ExecutionAttempt, step: Transition, result_complete: bool) -> AttemptPhase {
    return match step {
        Transition.Dispatch => {
            if value.phase != AttemptPhase.Prepared {
                abort("attempt dispatch has already been recorded");
            }
            AttemptPhase.Dispatching
        },
        Transition.Return => {
            if value.phase != AttemptPhase.Dispatching {
                abort("attempt is not awaiting a result");
            }
            AttemptPhase.Returned
        },
        Transition.Complete => {
            if value.result_event < 0 || !result_complete {
                abort("attempt has no complete saved result");
            }
            AttemptPhase.Completed
        },
        Transition.CloseUnknown => AttemptPhase.ClosedUnknown
    };
}

public type ExecutionAttempt = {
    id: string,
    session: string,
    kind: AttemptKind,
    label: string,
    phase: AttemptPhase,
    input_event: i64,
    through: i64,
    result_event: i64,
    recovery_event: i64
};

public flow wire_attempt(input: ExecutionAttempt) -> JsonValue ![] {
    return fields(
        json_value(input),
        [("kind", JsonValue.String(input.kind.wire())), ("phase", JsonValue.String(input.phase.wire()))]
    );
}
