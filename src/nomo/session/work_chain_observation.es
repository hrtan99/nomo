module nomo.session.work_chain_observation;

import nomo.session.edit_operation.selector_error;
import nomo.session.work_chain_selection.{Snapshot, validate, consistent};

// One cohesive replaceable dependency: the complete configured fixed-slot observation.
public enum ObservationPass { First, Recheck }
public effect SessionObservation { action capture(pass: ObservationPass) -> Result<Snapshot, string>; }
public flow observe(workspace: string, path: string) -> Result<Snapshot, string> ![SessionObservation.capture, Error<IndexError>] {
    let binding = selector_error("discovery", workspace, path); if binding != "" { return Err(binding); }
    let before = match perform SessionObservation.capture(ObservationPass.First) { Ok(value) => value, Err(error) => { return Err(error); } };
    let after = match perform SessionObservation.capture(ObservationPass.Recheck) { Ok(value) => value, Err(error) => { return Err(error); } };
    let change = consistent(before, after); if change != "" { return Err(change); }
    let invalid = validate(before, workspace, path); if invalid != "" { return Err(invalid); }
    return Ok(before);
}
