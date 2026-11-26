module nomo.application.sessions.observation;

import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.sessions.work_chain_selection.{Snapshot, validate, consistent};
import nomo.application.sessions.effects.session_work_chain_observation.SessionObservation;
import nomo.domain.sessions.work_chain_observation.ObservationPass;

public flow observe(workspace: string, path: string) -> Result<Snapshot, string> ![SessionObservation.capture, Error<IndexError>, Error<BudgetExceeded>] {
    let binding = selector_error("discovery", workspace, path); if binding != "" { return Err(binding); }
    let before = match perform SessionObservation.capture(ObservationPass.First) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match perform SessionObservation.capture(ObservationPass.Recheck) { Ok(value) => value, Err(error) => { return Err(error); } };
    let change = consistent(before, after); if change != "" { return Err(change); }
    let invalid = validate(before, workspace, path); if invalid != "" { return Err(invalid); }
    return Ok(before);
}
