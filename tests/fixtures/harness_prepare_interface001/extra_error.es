module app.callable_negative;
import std.fs.Region;
import nomo.harness.edit_original.OriginalReader;
type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(path: string) -> Result<string, string> ![Error<string>] ~ OriginalReader<FixtureRoot> {
    if path != "" { perform Error<string>.raise("intentional outside-bound error"); }
    return Err("unused");
}
public flow observe(args: Array<string>) -> i32 { return 0; }
