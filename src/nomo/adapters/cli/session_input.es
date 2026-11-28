module nomo.adapters.cli.session_input;

import nomo.application.sessions.chain.request_error;
import nomo.domain.editing.{Selector, selector_error};
import nomo.domain.harness.loop.{allowed_error, question_error};
import nomo.domain.limits.request_bytes;
import nomo.domain.sessions.chain.{ContinueRequest, TurnRequest, WorkRequest, policy, turn_caps};
import nomo.domain.sessions.state.valid_id;
import nomo.domain.text.{input_error, text_printable};
import std.text.{char_count, from_i32, parse_i32, split, starts_with, strip_suffix, trim};

public type ContinueOptions = {
    turn: Options,
    generation: i32,
    next_save: string
};

// Consume pairs atomically, including inputs that look like flags.
public flow parse_continue(args: Array<string>) -> Result<ContinueOptions, string> {
    if args.len() < 1 || args.len() > 17 || args[0] != "continue" {
        return Err("expected bounded continue arguments");
    }
    var normalized: Array<string> = ["save"];
    var next_save = "";
    var generation: i32 = -1;
    var seen_generation = false;
    var seen_next = false;
    var index: usize = 1;
    @limits([Iterations(8)]) while index < args.len() {
        if index + 1 >= args.len() {
            return Err("missing option value");
        }
        let flag = args[index];
        let value = args[index + 1];
        if flag == "--generation" {
            if seen_generation {
                return Err("duplicate option");
            }
            seen_generation = true;
            generation = match value {
                "0" => 0,
                "1" => 1,
                _ => -1
            };
            if generation < 0 {
                return Err("expected canonical generation 0 or 1");
            }
        } else if flag == "--next-save" {
            if seen_next {
                return Err("duplicate option");
            }
            seen_next = true;
            next_save = value;
        } else {
            normalized = normalized.push(flag).push(value);
        }
        index = index + 2;
    }
    let options = match session_cli_args_parse(normalized) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !seen_generation || !seen_next || !valid_id(next_save) || next_save == options.save_id {
        return Err("explicit generation and distinct valid next save required");
    }
    return Ok(ContinueOptions {
        turn = options,
        generation,
        next_save
    });
}

public enum SessionVerb {
    Help,
    Save,
    Show
}

impl SessionVerb {
    public flow wire(self) -> string ![] {
        return match self {
            SessionVerb.Help => "help",
            SessionVerb.Save => "save",
            SessionVerb.Show => "show"
        };
    }

    public flow parse(raw: string) -> SessionVerb ![] {
        return match raw {
            "help" => SessionVerb.Help,
            "save" => SessionVerb.Save,
            "show" => SessionVerb.Show,
            _ => abort("invalid SessionVerb spelling: " + raw)
        };
    }
}

public type Options = {
    verb: SessionVerb,
    session_id: string,
    save_id: string,
    binding: string,
    input: string,
    maximum: i32,
    budget: i32
};

flow parse_limit(value: string) -> i32 {
    return match parse_i32(value) {
        Ok(number) => if number >= 1 && number <= 16 && from_i32(number) == value {
            number
        } else {
            0
        },
        Err(_) => 0,
    };
}

// Parse the entire command before selecting any conversation or storage path.
public flow session_cli_args_parse(args: Array<string>) -> Result<Options, string> {
    if args.len() == 0 || args.len() > 13 {
        return Err("expected bounded save/show arguments");
    }
    let verb = args[0];
    if verb == "--help" && args.len() == 1 {
        let help = Options {
            verb = SessionVerb.Help,
            session_id = "",
            save_id = "",
            binding = "",
            input = "",
            maximum = 3,
            budget = 16
        };
        return Ok(help);
    }
    if verb != "save" && verb != "show" {
        return Err("expected save or show");
    }
    var session_id = "";
    var save_id = "";
    var binding = "";
    var input = "";
    var maximum: i32 = 3;
    var budget: i32 = 16;
    var seen: Array<string> = [];
    var supplied_input = false;
    var index: usize = 1;
    @limits([Iterations(6)]) while index < args.len() {
        let flag = args[index];
        if flag != "--session" && flag != "--save" && flag != "--binding" && flag != "--input"
            && flag != "--steps" && flag != "--budget" {
            return Err("unknown option");
        }
        if seen.iter().any(previous => previous == flag) {
            return Err("duplicate option");
        }
        seen = seen.push(flag);
        if index + 1 >= args.len() {
            return Err("missing option value");
        }
        let value = args[index + 1];
        if flag == "--session" {
            session_id = value;
        }
        else if flag == "--save" {
            save_id = value;
        }
        else if flag == "--binding" {
            binding = value;
        }
        else if flag == "--input" {
            input = value;
            supplied_input = true;
        }
        else {
            let parsed = parse_limit(value);
            if parsed == 0 {
                return Err("settings must be canonical decimal in 1..16");
            }
            if flag == "--steps" {
                maximum = parsed;
            } else {
                budget = parsed;
            }
        }
        index = index + 2;
    }
    if !valid_id(session_id) || !valid_id(save_id) || !valid_id(binding) {
        return Err("explicit valid session, save and binding required");
    }
    if verb == "save" {
        if !supplied_input {
            return Err("save requires input");
        }
        if char_count(input) > request_bytes() || !text_printable(input) {
            return Err("input must be bounded printable ASCII");
        }
        let invalid = input_error(input);
        if invalid != "" {
            return Err(invalid);
        }
    } else if supplied_input {
        return Err("show forbids input");
    }
    let options = Options {
        verb = SessionVerb.parse(verb),
        session_id,
        save_id,
        binding,
        input,
        maximum,
        budget
    };
    return Ok(options);
}

public type Config = {
    help: bool,
    root_id: string,
    child_id: string,
    parent: string,
    workspace: string,
    path: string,
    allowed: Array<string>,
    cap_raw: string,
    once_supplied: bool,
    once: string,
    latest: bool
};

public enum LineCommand {
    Request(string),
    Help,
    Show,
    Exit,
    Eof
}

flow configuration_error(value: Config, allow_latest: bool) -> string {
    if value.help {
        return "help configuration cannot dispatch work";
    }
    let child = selector_error(value.child_id, value.workspace, value.path);
    if child != "" {
        return child;
    }
    if value.latest {
        if !allow_latest || value.parent != "" || value.root_id != "" {
            return "latest parent must be resolved before dispatch";
        }
    } else {
        let root = selector_error(value.root_id, value.workspace, value.path);
        if root != "" {
            return root;
        }
        if value.root_id == value.child_id {
            return "terminal root and child IDs must differ";
        }
        if value.parent != "" && value.parent != value.root_id {
            return "terminal parent must equal the explicit root ID";
        }
    }
    let allowed = allowed_error(value.allowed);
    if allowed != "" {
        return allowed;
    }
    if value.cap_raw != "" {
        match policy(value.cap_raw) {
            Ok(_) => (),
            Err(error) => {
                return error;
            }
        }
    }
    if value.once_supplied {
        return question_error(value.once);
    }
    return "";
}

public flow terminal_args_parse(args: Array<string>) -> Result<Config, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(
            Config {
                help = true,
                root_id = "",
                child_id = "",
                parent = "",
                workspace = "",
                path = "",
                allowed = [],
                cap_raw = "",
                once_supplied = false,
                once = "",
                latest = false
            }
        );
    }
    if args.len() < 10 || args.len() > 16 {
        return Err("expected bounded terminal new or continue arguments");
    }
    let mode = args[0];
    if mode != "new" && mode != "continue" {
        return Err("expected terminal new, continue or standalone help");
    }
    var id = "";
    var child = "";
    var parent = "";
    var workspace = "";
    var path = "";
    var allow = "";
    var cap = "";
    var once = "";
    var supplied_once = false;
    var latest = false;
    var supplied_parent = false;
    var seen: Array<string> = [];
    var index: usize = 1;
    @limits([Iterations(8)]) while index < args.len() {
        let flag = args[index];
        index = index + 1;
        if seen.iter().any(previous => previous == flag) {
            return Err("duplicate terminal option");
        }
        seen = seen.push(flag);
        if flag == "--latest" {
            if mode != "continue" {
                return Err("latest parent selection requires terminal continue");
            }
            latest = true;
        } else {
            if index >= args.len() {
                return Err("terminal option value missing");
            }
            let value = args[index];
            index = index + 1;
            match flag {
                "--id" => {
                    id = value;
                }
                "--child-id" => {
                    if mode != "new" {
                        return Err("continuation cannot bind another child or third turn");
                    }
                    child = value;
                }
                "--parent" => {
                    if mode != "continue" {
                        return Err("new terminal work forbids --parent");
                    }
                    parent = value;
                    supplied_parent = true;
                }
                "--workspace" => {
                    workspace = value;
                }
                "--path" => {
                    path = value;
                }
                "--allow" => {
                    allow = value;
                }
                "--cap" => {
                    match policy(value) {
                        Ok(_) => (),
                        Err(error) => {
                            return Err(error);
                        }
                    }
                    cap = value;
                }
                "--once" => {
                    once = value;
                    supplied_once = true;
                }
                _ => {
                    return Err("unknown terminal option");
                }
            }
        }
    }
    if char_count(allow) > 97 {
        return Err("terminal allowlist exceeds 97 characters");
    }
    if latest && supplied_parent {
        return Err("--latest conflicts with explicit --parent");
    }
    if mode == "continue" && !latest && parent == "" {
        return Err("continuation requires explicit --parent or --latest");
    }
    let root = if mode == "new" {
        id
    } else {
        parent
    };
    let child_id = if mode == "new" {
        child
    } else {
        id
    };
    let result = Config {
        help = false,
        root_id = root,
        child_id,
        parent,
        workspace,
        path,
        allowed = split(allow, ","),
        cap_raw = cap,
        once_supplied = supplied_once,
        once,
        latest
    };
    let invalid = configuration_error(result, true);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(result);
}

public flow bind_parent(config: Config, parent: string) -> Result<Config, string> {
    if !config.latest {
        return Err("latest binding requires unresolved parent selection");
    }
    let startup = configuration_error(config, true);
    if startup != "" {
        return Err(startup);
    }
    let result = config {
        help = false,
        root_id = parent,
        parent,
        latest = false
    };
    let invalid = configuration_error(result, false);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(result);
}

// The supported non-TTY transport selects this entry, never an outer input loop.
public flow parse_once(args: Array<string>) -> Result<Config, string> {
    let config = match terminal_args_parse(args) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !config.help && !config.once_supplied {
        return Err("non-TTY terminal mode requires explicit --once REQUEST");
    }
    return Ok(config);
}

// Console returns an empty raw string for EOF; a blank LF/CRLF line is not EOF.
public flow line(raw: string) -> Result<LineCommand, string> {
    if raw == "" {
        return Ok(LineCommand.Eof);
    }
    if char_count(raw) > request_bytes() + 2 {
        return Err("raw terminal line exceeds 65536 characters plus LF/CRLF");
    }
    let body = match strip_suffix(raw, "\r\n") {
        Some(value) => value,
        None() => match strip_suffix(raw, "\n") {
            Some(value) => value,
            None() => raw
        }
    };
    if !text_printable(body) {
        return Err("expected printable ASCII terminal line");
    }
    if char_count(body) > request_bytes() {
        return Err("terminal line exceeds 65536 characters before trimming");
    }
    let text = trim(body);
    match text {
        "/help" => {
            return Ok(LineCommand.Help);
        }
        "/show" => {
            return Ok(LineCommand.Show);
        }
        "/exit" => {
            return Ok(LineCommand.Exit);
        }
        _ => (),
    }
    if starts_with(text, "/") {
        return Err("unknown terminal command; use /help, /show or /exit");
    }
    let invalid = question_error(text);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(LineCommand.Request(text));
}

public flow work_request(config: Config, turn: i32, request: string) -> Result<TurnRequest, string> {
    let invalid = configuration_error(config, false);
    if invalid != "" {
        return Err(invalid);
    }
    if turn != 1 && turn != 2 {
        return Err("terminal work forbids a third or invalid turn");
    }
    if turn == 1 && config.parent != "" {
        return Err("explicit continuation starts at the second turn");
    }
    if config.once_supplied && ((config.parent == "" && turn != 1) || (config.parent != "" && turn != 2)) {
        return Err("one-shot startup permits only its selected turn");
    }
    if config.once_supplied && request != config.once {
        return Err("one-shot request differs from its startup binding");
    }
    let invalid_request = question_error(request);
    if invalid_request != "" {
        return Err(invalid_request);
    }
    let id = if turn == 1 {
        config.root_id
    } else {
        config.child_id
    };
    let selected = Selector {
        id,
        workspace = config.workspace,
        path = config.path
    };
    let cap = if config.cap_raw == "" {
        turn_caps()
    } else {
        match policy(config.cap_raw) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        }
    };
    let value = WorkRequest {
        selected,
        request,
        allowed = config.allowed,
        cap
    };
    let result = if turn == 1 {
        TurnRequest.New(value)
    } else {
        TurnRequest.Continue(ContinueRequest {
            parent = config.root_id,
            work = value
        })
    };
    let error = request_error(result);
    if error != "" {
        return Err(error);
    }
    return Ok(result);
}

public flow show_selector(config: Config, turn: i32) -> Result<Selector, string> {
    let invalid = configuration_error(config, false);
    if invalid != "" {
        return Err(invalid);
    }
    if turn != 1 && turn != 2 {
        return Err("terminal show requires a bound first or second turn");
    }
    let id = if turn == 1 {
        config.root_id
    } else {
        config.child_id
    };
    return Ok(Selector {
        id,
        workspace = config.workspace,
        path = config.path
    });
}
