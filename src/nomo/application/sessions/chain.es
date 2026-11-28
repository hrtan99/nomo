module nomo.application.sessions.chain;

import nomo.application.sessions.ports.{DiscoveryAuthority, SessionObservation, TerminalRead, TerminalWork};
import nomo.domain.editing.{Selector as editing_Selector, selector_error};
import nomo.domain.harness.loop.{allowed_error, question_error};
import nomo.domain.harness.work.fresh;
import nomo.domain.sessions.chain.{
    CapturedShow,
    ObservationPass,
    ObservedRow,
    Record,
    Selector,
    Snapshot,
    TurnRequest,
    WorkOutcome,
    WorkRequest,
    WorkStop,
    consistent,
    policy_error,
    select,
    work_chain_selection_validate
};

// These contracts bound actual native adapters. Observations are copied values,
// never native receipts, versions or write authority.
public spec SnapshotCapture: callable ObservationPass => Result<Snapshot, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>
];

public spec InspectAuthority: callable (string, string, string) => Result<Option<Record>, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
];

public spec ConfirmedParentAuthority: callable (string, string, string) => Result<ObservedRow, string> ![
    Memory,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>
];

public flow discover(workspace: string, path: string, selector: Selector) -> Result<Snapshot, string> {
    let before = match observe(workspace, path) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let selected = match select(before, workspace, path, selector) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    @limits([Iterations(2)]) for row in selected {
        let actual = match perform DiscoveryAuthority.inspect(row.id, workspace, path) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        if actual != Some(row) {
            return Err("v2 discovery selected row differs from inspect authority");
        }
    }
    let after = match observe(workspace, path) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let change = consistent(before, after);
    if change != "" {
        return Err(change);
    }
    return Ok(before);
}

public flow latest_parent(workspace: string, path: string) -> Result<string, string> {
    let before = match observe(workspace, path) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let selected = match select(before, workspace, path, Selector.Parent) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let actual = match perform DiscoveryAuthority.confirmed_parent(selected[0].id, workspace, path) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let root = match before.root {
        Some(value) => value,
        None() => {
            return Err("v2 discovery parent missing");
        }
    };
    if actual.key != root.key || actual.version != root.version || actual.value != root.value {
        return Err("v2 discovered parent changed before continuation");
    }
    let after = match observe(workspace, path) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let change = consistent(before, after);
    if change != "" {
        return Err(change);
    }
    return Ok(actual.value.id);
}

public flow observe(workspace: string, path: string) -> Result<Snapshot, string> ![
    SessionObservation.capture,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let binding = selector_error("discovery", workspace, path);
    if binding != "" {
        return Err(binding);
    }
    let before = match perform SessionObservation.capture(ObservationPass.First) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let after = match perform SessionObservation.capture(ObservationPass.Recheck) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let change = consistent(before, after);
    if change != "" {
        return Err(change);
    }
    let invalid = work_chain_selection_validate(before, workspace, path);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(before);
}

public flow work(request: TurnRequest) -> WorkRequest {
    return match request {
        TurnRequest.New(value) => value,
        TurnRequest.Continue(value) => value.work
    };
}

public flow selected_error(selected: editing_Selector) -> string {
    return selector_error(selected.id, selected.workspace, selected.path);
}

public flow latest_error(workspace: string, path: string) -> string {
    return selector_error("discovery", workspace, path);
}

public flow request_error(request: TurnRequest) -> string {
    let value = work(request);
    let selected = selected_error(value.selected);
    if selected != "" {
        return selected;
    }
    let question = question_error(value.request);
    if question != "" {
        return question;
    }
    let allowed = allowed_error(value.allowed);
    if allowed != "" {
        return allowed;
    }
    let cap = policy_error(value.cap);
    if cap != "" {
        return cap;
    }
    match request {
        TurnRequest.Continue(next) => {
            let parent = selector_error(next.parent, value.selected.workspace, value.selected.path);
            if parent != "" {
                return parent;
            }
            if next.parent == value.selected.id {
                return "continuation requires a distinct child ID";
            }
        }
        TurnRequest.New(_) => (),
    }
    return "";
}

public flow dispatch(request: TurnRequest) -> WorkOutcome ![
    TerminalWork.execute,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let invalid = request_error(request);
    if invalid != "" {
        return WorkOutcome.Stopped(WorkStop {
            state = fresh(),
            error = invalid
        });
    }
    return perform TerminalWork.execute(request);
}

public flow read_selected(selected: editing_Selector) -> Result<Option<CapturedShow>, string> ![
    TerminalRead.show,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let invalid = selected_error(selected);
    if invalid != "" {
        return Err(invalid);
    }
    return perform TerminalRead.show(selected);
}

public flow read_latest(workspace: string, path: string) -> Result<string, string> ![
    TerminalRead.latest,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    let invalid = latest_error(workspace, path);
    if invalid != "" {
        return Err(invalid);
    }
    return perform TerminalRead.latest(workspace, path);
}
