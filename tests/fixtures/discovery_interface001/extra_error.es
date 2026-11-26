module app.callable_negative;
import nomo.domain.sessions.work_chain_selection.ObservedRow;
import nomo.application.sessions.discovery.ConfirmedParentAuthority;
flow bad(id: string, workspace: string, path: string) -> Result<ObservedRow, string> ![Error<string>] ~ ConfirmedParentAuthority {
    if id != "" { perform Error<string>.raise("intentional outside-bound error"); }
    return Err("unused");
}
public flow observe(args: Array<string>) -> i32 { return 0; }
