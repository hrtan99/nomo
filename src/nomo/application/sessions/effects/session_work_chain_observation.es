module nomo.application.sessions.effects.session_work_chain_observation;

import nomo.domain.sessions.work_chain_selection.Snapshot;
import nomo.domain.sessions.work_chain_observation.ObservationPass;

public effect SessionObservation { action capture(pass: ObservationPass) -> Result<Snapshot, string>; }
