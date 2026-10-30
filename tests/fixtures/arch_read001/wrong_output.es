module app.callable_negative;

import std.fs.Region;
import nomo.tools.read_contract.{Outcome, outcome, NomoRead};

type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(name: string) -> string ~ NomoRead<FixtureRoot> { return name; }
public flow main(args: Array<string>) -> i32 {
    let value = bad("a.txt");
    return 0;
}
