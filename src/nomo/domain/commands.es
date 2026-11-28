module nomo.domain.commands;



public type Argv = { program: string, arguments: Array<string> };

public enum ProcessRequest { Exec(Argv), Spawn(Argv), Jobs, Poll(string, usize), Send(string, string), CloseInput(string), Stop(string), Output(string), ArchivedOutput(string, usize) }

public enum Command {
    Empty, Quit, Help, Projects, Open(string), Git(GitRequest), Process(ProcessRequest),
    Tree(string), Glob(string), Search(string), History(string, i64, i64), Fork(Option<i64>),
    Read(string), Edits, Undo(string), Rollback(string), Recover(string), Sessions(bool),
    New(string), Resume(Option<string>), Rename(string), Export(string), Import(string), Copies,
    ResumeCopy(string), DiscardCopy(string), Runs, ResolveRun(string, string), Compact, Config, Check, Status, Ask(string)
}

public type CheckOutcome = { configured: bool, output: Array<CommandOutput> };

public type CommandRequest = { program: string, arguments: Array<string>, stdin: Option<string> };

public type CommandOutput = { exit_code: i32, stdout: string, stderr: string };

public type CommandObservation = { result_event: i64, output: CommandOutput };

public type CommandPreview = { program: string, arguments: Array<string> };

public type CommandInput = { program: string, arguments: Array<string>, stdin: string };

public enum CommandMode { Mutating, Observation(string) }

public type CommandJournal = { kind: string, role: string, name: string, label: string };

public flow journal(mode: CommandMode, program: string) -> CommandJournal {
    return match mode {
        CommandMode.Mutating => CommandJournal { kind = "command", role = "tool_call", name = "command", label = program },
        CommandMode.Observation(name) => CommandJournal { kind = "observation", role = "observation_call", name, label = name }
    };
}

public enum GitRequest {
    Status, Diff(bool, Array<string>), Log(i32), Branches, Init,
    Branch(string), Switch(string), Commit(string, Array<string>)
}
