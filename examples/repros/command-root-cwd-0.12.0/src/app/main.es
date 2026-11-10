module app.main;

import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};

type ProjectRoot;
impl ProjectRoot ~ Region;

flow main(args: Array<string>) -> i32 ![Command.run<DefaultCommandSandbox>] {
    let root = match path<ProjectRoot>(".") {
        Ok(value) => value,
        Err(_) => { abort("root path construction failed"); }
    };
    let result = run(with_cwd(command("/bin/pwd", []), root), DefaultCommandSandbox);
    return result.exit_code;
}
