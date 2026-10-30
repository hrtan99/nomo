module app.callable_negative;
import std.fs.Region;
import nomo.harness.edit_original.OriginalReader;
type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(path: i32) -> Result<string, string> ~ OriginalReader<FixtureRoot> { return Err("unused"); }
public flow observe(args: Array<string>) -> i32 { return 0; }
