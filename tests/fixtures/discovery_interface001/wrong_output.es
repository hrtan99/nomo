module app.callable_negative;
import nomo.session.work_chain_discovery.InspectAuthority;
flow bad(id: string, workspace: string, path: string) -> bool ~ InspectAuthority { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
