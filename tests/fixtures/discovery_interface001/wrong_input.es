module app.callable_negative;
import nomo.domain.sessions.chain.ObservationPass;
import nomo.domain.sessions.chain.Snapshot;
import nomo.application.sessions.chain.SnapshotCapture;
flow bad(pass: string) -> Result<Snapshot, string> ~ SnapshotCapture { return Err("unused"); }
public flow observe(args: Array<string>) -> i32 { return 0; }
