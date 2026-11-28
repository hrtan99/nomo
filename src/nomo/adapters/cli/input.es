module nomo.adapters.cli.input;

import nomo.domain.commands.{Argv, Command as commands_Command, GitRequest, ProcessRequest};
import nomo.domain.conversation.{Options, SessionSelection};
import nomo.domain.limits.request_bytes;
import nomo.domain.sessions.state.valid_id;
import nomo.domain.text.{input_error, safe, text_printable};
import std.agent.message.Message;
import std.json.parse;
import std.text.{
    char_count,
    from_i32,
    len,
    parse_i32,
    parse_i64,
    parse_usize,
    split_once,
    starts_with,
    strip_prefix,
    strip_suffix,
    trim
};

// CLI-001A: intents only; these records neither select storage nor authorize work.
public type Request = {
    kind: string,
    session_id: string,
    once_supplied: bool,
    once: string
};

public type LineCommand = {
    kind: string,
    text: string
};

public flow cli_request_parse_args(args: Array<string>) -> Result<Request, string> {
    if args.len() == 0 || args.len() > 5 {
        return Err("expected bounded new, resume or help arguments");
    }
    let verb = args[0];
    if verb == "help" || verb == "--help" {
        if args.len() != 1 {
            return Err("help must be used alone");
        }
        return Ok(Request {
            kind = "help",
            session_id = "",
            once_supplied = false,
            once = ""
        });
    }
    if verb != "new" && verb != "resume" {
        return Err("expected new, resume or help");
    }
    var session_id = "";
    var selected = false;
    var latest = false;
    var supplied = false;
    var input = "";
    var index: usize = 1;
    @limits([Iterations(4)]) while index < args.len() {
        let flag = args[index];
        if flag == "--latest" {
            if verb != "resume" {
                return Err("new forbids a resume selector");
            }
            if selected {
                return Err("duplicate or conflicting resume selector");
            }
            selected = true;
            latest = true;
            index = index + 1;
        } else {
            if flag != "--id" && flag != "--once" {
                return Err("unknown option");
            }
            if flag == "--id" {
                if verb != "resume" {
                    return Err("new forbids a resume selector");
                }
                if selected {
                    return Err("duplicate or conflicting resume selector");
                }
            } else if supplied {
                return Err("duplicate --once");
            }
            if index + 1 >= args.len() {
                return Err("missing option value");
            }
            // Values are literal: a valid ID or prompt may itself look like a flag.
            let value = args[index + 1];
            if flag == "--id" {
                if !valid_id(value) {
                    return Err("session ID must be 1..128 printable ASCII characters");
                }
                session_id = value;
                selected = true;
            } else {
                if char_count(value) > request_bytes() {
                    return Err("input exceeds 65536 characters");
                }
                if !text_printable(value) {
                    return Err("expected printable ASCII single-line input");
                }
                let invalid = input_error(value);
                if invalid != "" {
                    return Err(invalid);
                }
                input = value;
                supplied = true;
            }
            index = index + 2;
        }
    }
    if verb == "resume" && !selected {
        return Err("resume requires --id ID or --latest");
    }
    var kind = "new";
    if verb == "resume" {
        kind = "resume-id";
        if latest {
            kind = "resume-latest";
        }
    }
    return Ok(Request {
        kind,
        session_id,
        once_supplied = supplied,
        once = input
    });
}

// Raw Console line: the ceiling includes an optional single final LF/CRLF.
// Controls other than that framing cannot disappear silently through trim.
public flow cli_request_parse_line(raw: string) -> Result<LineCommand, string> {
    if char_count(raw) > request_bytes() {
        return Err("input exceeds 65536 characters");
    }
    let body = match strip_suffix(raw, "\r\n") {
        Some(value) => value,
        None() => match strip_suffix(raw, "\n") {
            Some(value) => value,
            None() => raw
        }
    };
    if !text_printable(body) {
        return Err("expected printable ASCII single-line input");
    }
    let command = trim(body);
    if command == "/help" {
        return Ok(LineCommand {
            kind = "help",
            text = ""
        });
    }
    if command == "/exit" {
        return Ok(LineCommand {
            kind = "exit",
            text = ""
        });
    }
    let invalid = input_error(command);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(LineCommand {
        kind = "prompt",
        text = command
    });
}

public type Config = {
    steps: i32,
    budget: i32,
    once: bool,
    request: string,
    help: bool,
    error: string
};

flow invalid(message: string) -> Config {
    return Config {
        steps = 0,
        budget = 0,
        once = false,
        request = "",
        help = false,
        error = message
    };
}

// Arguments are configuration; no file, environment or secret access is needed.
public flow load(args: Array<string>) -> Config {
    return load_for(args, "stub");
}

public flow load_for(args: Array<string>, provider: string) -> Config {
    if args.len() > 9 {
        return invalid("too many arguments");
    }
    var steps: i32 = 3;
    var budget: i32 = 16;
    var once = false;
    var request = "";
    var seen_steps = false;
    var seen_budget = false;
    var seen_model = false;
    var index: usize = 0;
    @limits([Iterations(10)]) while index < args.len() {
        let flag = args[index];
        if flag == "--help" {
            if args.len() != 1 {
                return invalid("--help must be used alone");
            }
            return Config {
                steps,
                budget,
                once = false,
                request = "",
                help = true,
                error = ""
            };
        }
        if flag == "--resume" || flag == "--persist" || flag == "--live" || flag == "--tools"
            || flag == "--cancel" {
            return invalid("unsupported mode: " + flag);
        }
        if flag != "--model" && flag != "--steps" && flag != "--budget" && flag != "--once" {
            return invalid("unknown option");
        }
        if index + 1 >= args.len() {
            return invalid("missing option value");
        }
        let value = args[index + 1];
        if flag == "--model" {
            if seen_model {
                return invalid("duplicate --model");
            }
            if value != provider {
                return invalid("unsupported model; only " + provider + " is available");
            }
            seen_model = true;
        }
        if flag == "--steps" || flag == "--budget" {
            if flag == "--steps" && seen_steps {
                return invalid("duplicate --steps");
            }
            if flag == "--budget" && seen_budget {
                return invalid("duplicate --budget");
            }
            let parsed = match parse_i32(value) {
                Ok(number) => if number >= 1 && number <= 16 && from_i32(number) == value {
                    number
                } else {
                    0
                },
                Err(_) => 0,
            };
            if parsed < 1 || parsed > 16 {
                if flag == "--steps" {
                    return invalid("steps must be canonical decimal in 1..16");
                }
                return invalid("budget must be canonical decimal in 1..16");
            }
            if flag == "--steps" {
                steps = parsed;
                seen_steps = true;
            }
            else {
                budget = parsed;
                seen_budget = true;
            }
        }
        if flag == "--once" {
            if once {
                return invalid("duplicate --once");
            }
            once = true;
            request = value;
        }
        index = index + 2;
    }
    if provider != "stub" && !seen_model {
        return invalid("model entry requires --model " + provider);
    }
    return Config {
        steps,
        budget,
        once,
        request,
        help = false,
        error = ""
    };
}

// Only the non-durable read-only entry uses this parser. Legacy session and
// edit arguments retain their existing parser and wire contract.
flow prompt_error(value: string) -> string {
    if len(value) > request_bytes() {
        return "question exceeds 65536 UTF-8 bytes";
    }
    if trim(value) == "" || !safe(value, request_bytes()) {
        return "question requires nonblank safe single-line UTF-8";
    }
    if starts_with(trim(value), "/") {
        return "unsupported command; use /help or /exit";
    }
    return "";
}

public flow read_cli_parse_args(args: Array<string>) -> Result<Request, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Request {
            kind = "help",
            session_id = "",
            once_supplied = false,
            once = ""
        });
    }
    if args.len() != 3 || args[0] != "new" || args[1] != "--once" {
        return Err("expected new --once TEXT");
    }
    let invalid = prompt_error(args[2]);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(Request {
        kind = "new",
        session_id = "",
        once_supplied = true,
        once = args[2]
    });
}

public flow read_cli_parse_line(raw: string) -> Result<LineCommand, string> {
    if len(raw) > request_bytes() + 2 {
        return Err("input exceeds 65536 UTF-8 bytes plus LF/CRLF");
    }
    let body = match strip_suffix(raw, "\r\n") {
        Some(value) => value,
        None() => match strip_suffix(raw, "\n") {
            Some(value) => value,
            None() => raw
        }
    };
    if !safe(body, request_bytes()) {
        return Err("unsafe terminal character");
    }
    let command = trim(body);
    if command == "/help" {
        return Ok(LineCommand {
            kind = "help",
            text = ""
        });
    }
    if command == "/exit" {
        return Ok(LineCommand {
            kind = "exit",
            text = ""
        });
    }
    let invalid = prompt_error(command);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(LineCommand {
        kind = "prompt",
        text = command
    });
}

flow argv(raw: string) -> Argv {
    let parsed = match parse(raw) {
        Ok(value) => value,
        Err(_) => abort("use a JSON argv array, for example [\"/usr/bin/git\",\"status\"]"),
    };
    let decoded: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
    let values = match decoded {
        Some(value) => value.body,
        None() => abort("command argv must be a JSON array of strings"),
    };
    let program = match values.iter().nth(0) {
        Some(value) => value,
        None() => ""
    };
    let arguments = values.iter().skip(1).collect();
    if program == "" {
        abort("provide a command program");
    }
    return Argv {
        program,
        arguments
    };
}

flow event_index(raw: string) -> i64 {
    return match parse_i64(trim(raw)) {
        Ok(value) => {
            if value < 0 {
                abort("event index must be nonnegative");
            }
            value
        },
        Err(_) => abort("expected an event index"),
    };
}

flow process(operation: string, argument: string) -> ProcessRequest {
    if operation == "/exec" {
        return ProcessRequest.Exec(argv(argument));
    }
    if operation == "/spawn" {
        return ProcessRequest.Spawn(argv(argument));
    }
    if operation == "/jobs" {
        return ProcessRequest.Jobs;
    }
    if operation == "/archived-output" {
        let (job, part) = match split_once(argument, " ") {
            Some(parts) => parts,
            None() => (argument, "0")
        };
        let index = match parse_usize(trim(part)) {
            Ok(value) => value,
            Err(_) => abort("expected an archived output part number"),
        };
        return ProcessRequest.ArchivedOutput(job, index);
    }
    if operation == "/poll" {
        let (job, bytes) = match split_once(argument, " ") {
            Some(parts) => parts,
            None() => (argument, "65536")
        };
        let count = match parse_usize(trim(bytes)) {
            Ok(value) => value,
            Err(_) => abort("expected a read byte count"),
        };
        return ProcessRequest.Poll(job, count);
    }
    if operation == "/send" {
        let (job, input) = match split_once(argument, " ") {
            Some(parts) => parts,
            None() => abort("use /send JOB JSON_STRING"),
        };
        let parsed = match parse(input) {
            Ok(value) => value,
            Err(_) => abort("input must be a JSON string; use \\n for a newline"),
        };
        let converted: Option<Message<string>> = Message.new(parsed).cast<string>();
        let text = match converted {
            Some(value) => value.body,
            None() => abort("input must be a JSON string"),
        };
        return ProcessRequest.Send(job, text);
    }
    if operation == "/close-input" {
        return ProcessRequest.CloseInput(argument);
    }
    if operation == "/stop" {
        return ProcessRequest.Stop(argument);
    }
    return ProcessRequest.Output(argument);
}

public flow command(request: string) -> commands_Command {
    if request == "" {
        return commands_Command.Empty;
    }
    if request == "/quit" || request == "/exit" {
        return commands_Command.Quit;
    }
    if request == "/help" {
        return commands_Command.Help;
    }
    if request == "/projects" {
        return commands_Command.Projects;
    }
    if request == "/open" {
        return commands_Command.Open("");
    }
    match strip_prefix(request, "/open ") {
        Some(value) => {
            return commands_Command.Open(value);
        }
        None() => (),
    }
    if request == "/git" {
        return commands_Command.Git(git_parse("status"));
    }
    match strip_prefix(request, "/git ") {
        Some(value) => {
            return commands_Command.Git(git_parse(value));
        }
        None() => (),
    }
    let (operation, argument) = match split_once(request, " ") {
        Some(parts) => parts,
        None() => (request, "")
    };
    if operation == "/exec" || operation == "/spawn" || operation == "/jobs" || operation == "/poll"
        || operation == "/send" || operation == "/close-input" || operation == "/stop"
        || operation == "/job-output" || operation == "/archived-output" {
        return commands_Command.Process(process(operation, trim(argument)));
    }
    if request == "/tree" {
        return commands_Command.Tree(".");
    }
    match strip_prefix(request, "/tree ") {
        Some(value) => {
            return commands_Command.Tree(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/glob ") {
        Some(value) => {
            return commands_Command.Glob(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/search ") {
        Some(value) => {
            return commands_Command.Search(trim(value));
        }
        None() => (),
    }
    if request == "/history" || request == "/events" {
        return commands_Command.History("", 0, -1);
    }
    match strip_prefix(request, "/history ") {
        Some(value) => {
            return commands_Command.History(trim(value), 0, -1);
        }
        None() => (),
    }
    match strip_prefix(request, "/page ") {
        Some(value) => {
            return commands_Command.History("", event_index(value), 50);
        }
        None() => (),
    }
    if request == "/fork" {
        return commands_Command.Fork(None());
    }
    match strip_prefix(request, "/fork ") {
        Some(value) => {
            return commands_Command.Fork(Some(event_index(value)));
        }
        None() => (),
    }
    match strip_prefix(request, "/read ") {
        Some(value) => {
            return commands_Command.Read(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/recover ") {
        Some(value) => {
            return commands_Command.Recover(trim(value));
        }
        None() => (),
    }
    if request == "/edits" {
        return commands_Command.Edits;
    }
    if request == "/undo" {
        return commands_Command.Undo("");
    }
    match strip_prefix(request, "/undo ") {
        Some(value) => {
            return commands_Command.Undo(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/rollback ") {
        Some(value) => {
            return commands_Command.Rollback(trim(value));
        }
        None() => (),
    }
    if request == "/sessions" {
        return commands_Command.Sessions(false);
    }
    if request == "/sessions all" {
        return commands_Command.Sessions(true);
    }
    if request == "/new" {
        return commands_Command.New("New conversation");
    }
    match strip_prefix(request, "/new ") {
        Some(value) => {
            return commands_Command.New(trim(value));
        }
        None() => (),
    }
    if request == "/resume" {
        return commands_Command.Resume(None());
    }
    match strip_prefix(request, "/resume ") {
        Some(value) => {
            return commands_Command.Resume(Some(trim(value)));
        }
        None() => (),
    }
    match strip_prefix(request, "/rename ") {
        Some(value) => {
            return commands_Command.Rename(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/export ") {
        Some(value) => {
            return commands_Command.Export(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/import ") {
        Some(value) => {
            return commands_Command.Import(trim(value));
        }
        None() => (),
    }
    if request == "/copies" {
        return commands_Command.Copies;
    }
    match strip_prefix(request, "/resume-copy ") {
        Some(value) => {
            return commands_Command.ResumeCopy(trim(value));
        }
        None() => (),
    }
    match strip_prefix(request, "/discard-copy ") {
        Some(value) => {
            return commands_Command.DiscardCopy(trim(value));
        }
        None() => (),
    }
    if request == "/runs" {
        return commands_Command.Runs;
    }
    match strip_prefix(request, "/resolve-run ") {
        Some(value) => {
            let (id, note) = match split_once(trim(value), " ") {
                Some(parts) => parts,
                None() => (trim(value), "")
            };
            return commands_Command.ResolveRun(id, trim(note));
        }
        None() => (),
    }
    if request == "/compact" {
        return commands_Command.Compact;
    }
    if request == "/config" {
        return commands_Command.Config;
    }
    if request == "/check" {
        return commands_Command.Check;
    }
    if request == "/status" {
        return commands_Command.Status;
    }
    return commands_Command.Ask(request);
}

type CommitRequest = {
    message: string,
    paths: Array<string>
};

flow json_paths(raw: string) -> Array<string> {
    if trim(raw) == "" {
        return [];
    }
    let parsed = match parse(raw) {
        Ok(value) => value,
        Err(_) => abort("provide paths as a JSON string array"),
    };
    let converted: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
    return match converted {
        Some(value) => value.body,
        None() => abort("paths must be a JSON string array"),
    };
}

/// Parse native Git input into the same application requests used by model tools.
public flow git_parse(raw: string) -> GitRequest {
    let (operation, rest) = match split_once(trim(raw), " ") {
        Some(parts) => parts,
        None() => (trim(raw), "")
    };
    let argument = trim(rest);
    if operation == "status" {
        return GitRequest.Status;
    }
    if operation == "branches" {
        return GitRequest.Branches;
    }
    if operation == "init" {
        return GitRequest.Init;
    }
    if operation == "branch" {
        return GitRequest.Branch(argument);
    }
    if operation == "switch" {
        return GitRequest.Switch(argument);
    }
    if operation == "log" {
        let count = if argument == "" {
            20
        } else {
            match parse_i32(argument) {
                Ok(value) => value,
                Err(_) => abort("expected a Git log count"),
            }
        };
        return GitRequest.Log(count);
    }
    if operation == "diff" {
        var staged = false;
        var selected = argument;
        if argument == "--staged" {
            staged = true;
            selected = "";
        }
        else {
            match strip_prefix(argument, "--staged ") {
                Some(value) => {
                    staged = true;
                    selected = value;
                }
                None() => (),
            }
        }
        return GitRequest.Diff(staged, json_paths(selected));
    }
    if operation == "commit" {
        let parsed = match parse(argument) {
            Ok(value) => value,
            Err(_) => abort("use /git commit with JSON containing message and paths"),
        };
        let converted: Option<Message<CommitRequest>> = Message.new(parsed).cast<CommitRequest>();
        let request = match converted {
            Some(value) => value.body,
            None() => abort("commit JSON requires message:string and paths:Array<string>"),
        };
        return GitRequest.Commit(request.message, request.paths);
    }
    abort("Git command: status, diff [--staged] [JSON_PATHS], log [COUNT], branches, init, branch NAME, switch NAME, commit JSON");
}

public flow options_parse(args: Array<string>) -> Options ![Error<IndexError>, Error<BudgetExceeded>] {
    var workspace = "";
    var selection = SessionSelection.Current;
    var once: Option<string> = None();
    var open_project: Option<string> = None();
    var projects = false;
    var sessions = false;
    var all_sessions = false;
    var history = false;
    var status = false;
    var title: Option<string> = None();
    var import_path: Option<string> = None();
    var export_path: Option<string> = None();
    var check: Option<Array<string>> = None();
    var index: usize = 0;
    @limits([Iterations(2147483647)]) while index < args.len() {
        let (option, inline) = match split_once(args[index], "=") {
            Some((name, value)) => (name, Some(value)),
            None() => (args[index], None())
        };
        index = index + 1;
        if option == "--new" {
            selection = SessionSelection.Fresh;
            continue;
        }
        if option == "--latest" {
            selection = SessionSelection.Existing;
            continue;
        }
        if option == "--projects" {
            projects = true;
            continue;
        }
        if option == "--sessions" {
            sessions = true;
            continue;
        }
        if option == "--all" {
            all_sessions = true;
            continue;
        }
        if option == "--history" || option == "--events" {
            history = true;
            continue;
        }
        if option == "--status" {
            status = true;
            continue;
        }
        if option == "--high-input" {
            continue;
        }
        if option == "--check" {
            var command: Array<string> = match inline {
                Some(value) => [value],
                None() => []
            };
            command = command.extend(args.iter().skip(index).collect());
            index = args.len();
            if command.len() == 0 {
                abort("--check requires a command");
            }
            check = Some(command);
            continue;
        }
        if option == "--resume" || option == "--open" {
            var selected = match inline {
                Some(value) => value,
                None() => ""
            };
            if selected == "" && index < args.len() {
                let value_follows = match strip_prefix(args[index], "--") {
                    Some(_) => false,
                    None() => true
                };
                if value_follows {
                    selected = args[index];
                    index = index + 1;
                }
            }
            if option == "--open" {
                open_project = Some(selected);
            }
            else {
                selection = if selected == "" {
                    SessionSelection.Choose
                } else {
                    SessionSelection.Exact(selected)
                };
            }
            continue;
        }
        let value = match inline {
            Some(value) => value,
            None() => {
                if index >= args.len() {
                    abort("native option requires a value: " + option);
                }
                let value = args[index];
                index = index + 1;
                value
            }
        };
        if option == "--workspace" || option == "--root" {
            workspace = value;
        }
        else if option == "--id" {
            selection = SessionSelection.Exact(value);
        }
        else if option == "--once" {
            once = Some(value);
        }
        else if option == "--title" {
            title = Some(value);
        }
        else if option == "--import" {
            import_path = Some(value);
        }
        else if option == "--export" {
            export_path = Some(value);
        }
        else {
            abort("unknown native entry option: " + option);
        }
    }
    if workspace == "" {
        abort("provide --workspace with the folder mounted as /project");
    }
    return Options {
        workspace,
        selection,
        once,
        open_project,
        projects,
        sessions,
        all_sessions,
        history,
        status,
        title,
        import_path,
        export_path,
        check
    };
}
