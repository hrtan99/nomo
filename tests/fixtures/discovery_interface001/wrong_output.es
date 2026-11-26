module app.callable_negative;
import nomo.application.sessions.discovery.InspectAuthority;
flow bad(id: string, workspace: string, path: string) -> bool ~ InspectAuthority { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
