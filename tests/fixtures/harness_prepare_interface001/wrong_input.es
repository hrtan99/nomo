module app.callable_negative;
import std.fs.Region;
import nomo.application.editing.ports.OriginalReader;
type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(path: i32) -> Result<string, string> ~ OriginalReader<FixtureRoot> { return Err("unused"); }
public flow observe(args: Array<string>) -> i32 { return 0; }
