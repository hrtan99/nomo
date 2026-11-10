module nomo.native.entry;

import std.io.println;
import std.collections.len;
import nomo.native.agent.NativeCoding;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};

public flow run(args: Array<string>) -> i32
    ![Agentic, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
    if len(args) != 1 { abort("provide the project request as one argument"); }
    let answer = NativeCoding.run(args[0]);
    println(answer.text);
    return 0;
}
