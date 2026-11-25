module nomo.entry.native.commands;

import std.text.{trim, strip_prefix, split_once, parse_i64, parse_usize};
import std.json.parse;
import std.agent.message.Message;

public type Argv = { program: string, arguments: Array<string> };
public enum ProcessRequest { Exec(Argv), Spawn(Argv), Jobs, Poll(string, usize), Send(string, string), CloseInput(string), Stop(string), Output(string) }
public enum Command {
    Empty, Quit, Help, Projects, Open(string), Git(string), Process(ProcessRequest),
    Tree(string), Glob(string), Search(string), History(string, i64, i64), Fork(Option<i64>),
    Read(string), Edits, Undo(string), Rollback(string), Recover(string), Sessions,
    New(string), Resume(string), Rename(string), Export(string), Import(string), Copies,
    ResumeCopy(string), DiscardCopy(string), Runs, ResolveRun(string, string), Compact, Config, Check, Status, Ask(string)
}

flow argv(raw: string) -> Argv {
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { abort("use a JSON argv array, for example [\"/usr/bin/git\",\"status\"]"); } };
    let decoded: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
    let values = match decoded { Some(value) => value.body, None() => { abort("command argv must be a JSON array of strings"); } };
    var program = "";
    var first = true;
    var arguments: Array<string> = [];
    for value in values limit Iterations(2147483647) {
        if first { program = value; first = false; } else { arguments = arguments.push(value); }
    }
    if program == "" { abort("provide a command program"); }
    return Argv { program = program, arguments = arguments };
}
flow event_index(raw: string) -> i64 {
    return match parse_i64(trim(raw)) {
        Ok(value) => { if value < 0 { abort("event index must be nonnegative"); } value },
        Err(_) => { abort("expected an event index"); }
    };
}
flow process(operation: string, argument: string) -> ProcessRequest {
    if operation == "/exec" { return ProcessRequest.Exec(argv(argument)); }
    if operation == "/spawn" { return ProcessRequest.Spawn(argv(argument)); }
    if operation == "/jobs" { return ProcessRequest.Jobs; }
    if operation == "/poll" {
        let (job, bytes) = match split_once(argument, " ") { Some(parts) => parts, None() => (argument, "65536") };
        let count = match parse_usize(trim(bytes)) { Ok(value) => value, Err(_) => { abort("expected a read byte count"); } };
        return ProcessRequest.Poll(job, count);
    }
    if operation == "/send" {
        let (job, input) = match split_once(argument, " ") { Some(parts) => parts, None() => { abort("use /send JOB JSON_STRING"); } };
        let parsed = match parse(input) { Ok(value) => value, Err(_) => { abort("input must be a JSON string; use \\n for a newline"); } };
        let converted: Option<Message<string>> = Message.new(parsed).cast<string>();
        let text = match converted { Some(value) => value.body, None() => { abort("input must be a JSON string"); } };
        return ProcessRequest.Send(job, text);
    }
    if operation == "/close-input" { return ProcessRequest.CloseInput(argument); }
    if operation == "/stop" { return ProcessRequest.Stop(argument); }
    return ProcessRequest.Output(argument);
}

public flow command(request: string) -> Command {
    if request == "" { return Command.Empty; }
    if request == "/quit" || request == "/exit" { return Command.Quit; }
    if request == "/help" { return Command.Help; }
    if request == "/projects" { return Command.Projects; }
    if request == "/open" { return Command.Open(""); }
    match strip_prefix(request, "/open ") { Some(value) => { return Command.Open(value); } None() => {} }
    if request == "/git" { return Command.Git("status"); }
    match strip_prefix(request, "/git ") { Some(value) => { return Command.Git(value); } None() => {} }
    let (operation, argument) = match split_once(request, " ") { Some(parts) => parts, None() => (request, "") };
    if operation == "/exec" || operation == "/spawn" || operation == "/jobs" || operation == "/poll" || operation == "/send" || operation == "/close-input" || operation == "/stop" || operation == "/job-output" {
        return Command.Process(process(operation, trim(argument)));
    }
    if request == "/tree" { return Command.Tree("."); }
    match strip_prefix(request, "/tree ") { Some(value) => { return Command.Tree(trim(value)); } None() => {} }
    match strip_prefix(request, "/glob ") { Some(value) => { return Command.Glob(trim(value)); } None() => {} }
    match strip_prefix(request, "/search ") { Some(value) => { return Command.Search(trim(value)); } None() => {} }
    if request == "/history" || request == "/events" { return Command.History("", 0, -1); }
    match strip_prefix(request, "/history ") { Some(value) => { return Command.History(trim(value), 0, -1); } None() => {} }
    match strip_prefix(request, "/page ") { Some(value) => { return Command.History("", event_index(value), 50); } None() => {} }
    if request == "/fork" { return Command.Fork(None()); }
    match strip_prefix(request, "/fork ") { Some(value) => { return Command.Fork(Some(event_index(value))); } None() => {} }
    match strip_prefix(request, "/read ") { Some(value) => { return Command.Read(trim(value)); } None() => {} }
    match strip_prefix(request, "/recover ") { Some(value) => { return Command.Recover(trim(value)); } None() => {} }
    if request == "/edits" { return Command.Edits; }
    if request == "/undo" { return Command.Undo(""); }
    match strip_prefix(request, "/undo ") { Some(value) => { return Command.Undo(trim(value)); } None() => {} }
    match strip_prefix(request, "/rollback ") { Some(value) => { return Command.Rollback(trim(value)); } None() => {} }
    if request == "/sessions" { return Command.Sessions; }
    if request == "/new" { return Command.New("New conversation"); }
    match strip_prefix(request, "/new ") { Some(value) => { return Command.New(trim(value)); } None() => {} }
    match strip_prefix(request, "/resume ") { Some(value) => { return Command.Resume(trim(value)); } None() => {} }
    match strip_prefix(request, "/rename ") { Some(value) => { return Command.Rename(trim(value)); } None() => {} }
    match strip_prefix(request, "/export ") { Some(value) => { return Command.Export(trim(value)); } None() => {} }
    match strip_prefix(request, "/import ") { Some(value) => { return Command.Import(trim(value)); } None() => {} }
    if request == "/copies" { return Command.Copies; }
    match strip_prefix(request, "/resume-copy ") { Some(value) => { return Command.ResumeCopy(trim(value)); } None() => {} }
    match strip_prefix(request, "/discard-copy ") { Some(value) => { return Command.DiscardCopy(trim(value)); } None() => {} }
    if request == "/runs" { return Command.Runs; }
    match strip_prefix(request, "/resolve-run ") {
        Some(value) => {
            let (id, note) = match split_once(trim(value), " ") { Some(parts) => parts, None() => (trim(value), "") };
            return Command.ResolveRun(id, trim(note));
        }
        None() => {}
    }
    if request == "/compact" { return Command.Compact; }
    if request == "/config" { return Command.Config; }
    if request == "/check" { return Command.Check; }
    if request == "/status" { return Command.Status; }
    return Command.Ask(request);
}
