module nomo.domain.conversation.commands;

import nomo.domain.execution.git.GitRequest;

public type Argv = { program: string, arguments: Array<string> };
public enum ProcessRequest { Exec(Argv), Spawn(Argv), Jobs, Poll(string, usize), Send(string, string), CloseInput(string), Stop(string), Output(string) }
public enum Command {
    Empty, Quit, Help, Projects, Open(string), Git(GitRequest), Process(ProcessRequest),
    Tree(string), Glob(string), Search(string), History(string, i64, i64), Fork(Option<i64>),
    Read(string), Edits, Undo(string), Rollback(string), Recover(string), Sessions,
    New(string), Resume(string), Rename(string), Export(string), Import(string), Copies,
    ResumeCopy(string), DiscardCopy(string), Runs, ResolveRun(string, string), Compact, Config, Check, Status, Ask(string)
}
