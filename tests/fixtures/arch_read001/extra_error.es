module app.callable_negative;

import std.fs.Region;
import nomo.tools.read_contract.{Outcome, outcome, NomoRead};

type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(name: string) -> Outcome ![Error<string>] ~ NomoRead<FixtureRoot> {
    if name == "a.txt" { perform Error<string>.raise("intentional outside-bound error"); }
    return outcome("refused", "unreachable admitted input", 0);
}
public flow main(args: Array<string>) -> i32 {
    let value = bad("a.txt");
    return 0;
}
