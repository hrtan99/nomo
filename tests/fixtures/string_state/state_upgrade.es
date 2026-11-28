module app.state_upgrade;

import nomo.domain.editing.Binding;
import nomo.domain.sessions.state.{EventReference, ReferencePhase};
import nomo.domain.sessions.work.{CheckOutcome, CheckState, ContinuousEditState, SummaryProvenance, SummarySource, SummaryState, WorkProfile};

public flow check_state(phase: string, outcome: string, exit: string) -> CheckState ![] {
    if phase == "complete" {
        return CheckState.Complete(
            match CheckOutcome.parse(outcome, exit) {
                Ok(value) => value,
                Err(error) => abort(error)
            }
        );
    }
    if outcome != "" || exit != "" {
        abort("unfinished historical check has an outcome");
    }
    return match phase {
        "none" => CheckState.NotRequested,
        "planned" => CheckState.Planned,
        "running" => CheckState.Running,
        "abandoned" => CheckState.Abandoned,
        _ => abort("invalid historical check phase")
    };
}

public flow reference(operation: string, phase: string) -> EventReference ![] {
    if operation == "" && phase == "" {
        return EventReference.Unbound;
    }
    if operation == "" {
        abort("historical reference has no operation");
    }
    return EventReference.Bound(operation, ReferencePhase.parse(phase));
}

public flow edit(phase: string, binding: Option<Binding>) -> ContinuousEditState ![] {
    return match phase {
        "none" => match binding {
            None() => ContinuousEditState.NotStarted,
            Some(_) => abort("historical unstarted edit has a binding")
        },
        "intent" => ContinuousEditState.Intent(binding.unwrap()),
        "completed" => ContinuousEditState.Completed(binding.unwrap()),
        _ => abort("invalid historical continuous edit phase")
    };
}

flow provenance(raw: string) -> SummaryProvenance ![] {
    return match raw {
        "model" => SummaryProvenance.Unversioned(SummarySource.Model),
        "system" => SummaryProvenance.Unversioned(SummarySource.System),
        "unknown" => SummaryProvenance.Unversioned(SummarySource.Unknown),
        "model-v2" => SummaryProvenance.V2(SummarySource.Model),
        "system-v2" => SummaryProvenance.V2(SummarySource.System),
        "model-v3" => SummaryProvenance.V3(SummarySource.Model),
        "system-v3" => SummaryProvenance.V3(SummarySource.System),
        "model-v4" => SummaryProvenance.V4(SummarySource.Model),
        "system-v4" => SummaryProvenance.V4(SummarySource.System),
        "model-v5" => SummaryProvenance.V5(SummarySource.Model),
        "system-v5" => SummaryProvenance.V5(SummarySource.System),
        "model-high-input" => SummaryProvenance.HighInput(SummarySource.Model),
        "system-high-input" => SummaryProvenance.HighInput(SummarySource.System),
        "model-high-input-v2" => SummaryProvenance.HighInputV2(SummarySource.Model),
        "system-high-input-v2" => SummaryProvenance.HighInputV2(SummarySource.System),
        _ => abort("invalid historical summary provenance")
    };
}

public flow summary(phase: string, source: string) -> SummaryState ![] {
    return match phase {
        "running" => SummaryState.Running(WorkProfile.parse(source)),
        "abandoned" => SummaryState.Abandoned(WorkProfile.parse(source)),
        "complete" => SummaryState.Complete(provenance(source)),
        _ => abort("invalid historical summary phase")
    };
}
