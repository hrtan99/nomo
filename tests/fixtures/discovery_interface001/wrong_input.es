module app.callable_negative;
import nomo.session.work_chain_observation.ObservationPass;
import nomo.session.work_chain_selection.Snapshot;
import nomo.session.work_chain_discovery.SnapshotCapture;
flow bad(pass: string) -> Result<Snapshot, string> ~ SnapshotCapture { return Err("unused"); }
public flow observe(args: Array<string>) -> i32 { return 0; }
