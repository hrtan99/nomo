module app.main;

import std.fs.{Region, WorkspacePath};

type ReproRoot;
impl ReproRoot ~ Region;

flow main(args: Array<string>) -> i32
{
    let _path = WorkspacePath<ReproRoot> { path = "input.txt" };
    return 0;
}
