module etas004.constructor_gap;

import std.fs.{Region, WorkspacePath};

type FixtureRoot;
impl FixtureRoot ~ Region;

flow main(args: Array<string>) -> i32
{
    let _path = WorkspacePath<FixtureRoot> { path = "input.txt" };
    return 0;
}
