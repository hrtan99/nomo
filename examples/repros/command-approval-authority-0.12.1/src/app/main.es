module app.main;

import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};

type ProjectRoot;
impl ProjectRoot ~ Region;

flow main(args: Array<string>) -> i32 ![Command.run<DefaultCommandSandbox>] {
    let cwd = match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => { abort("invalid cwd"); } };
    let first = run(with_cwd(command("/bin/echo", ["first"]), cwd), DefaultCommandSandbox);
    let second = run(with_cwd(command("/bin/echo", ["second"]), cwd), DefaultCommandSandbox);
    return first.exit_code + second.exit_code;
}
