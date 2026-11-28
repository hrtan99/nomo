module app.callable_negative;
import std.fs.Region;
import nomo.application.editing.ports.OriginalReader;
type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(path: string) -> bool ~ OriginalReader<FixtureRoot> { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
