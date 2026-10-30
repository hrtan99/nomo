module nomo.cli.terminal_args;

import std.collections.len as count;
import std.text.{len, split, trim, starts_with};
import nomo.core.text.printable;
import nomo.session.edit_operation.selector_error;
import nomo.model.model_tool_contract.{question_error, allowed_error};
import nomo.session.work_chain.{policy, turn_caps};
import nomo.tools.edit_contract.Selector;
import nomo.session.work_chain_usecase.{WorkRequest, ContinueRequest, TurnRequest, request_error};

public type Config = { help: bool, root_id: string, child_id: string, parent: string,
    workspace: string, path: string, allowed: Array<string>, cap_raw: string,
    once_supplied: bool, once: string, latest: bool };
public enum LineCommand { Request(string), Help, Show, Exit, Eof }

flow configuration_error(value: Config, allow_latest: bool) -> string {
    if value.help { return "help configuration cannot dispatch work"; }
    let child = selector_error(value.child_id, value.workspace, value.path); if child != "" { return child; }
    if value.latest {
        if !allow_latest || value.parent != "" || value.root_id != "" { return "latest parent must be resolved before dispatch"; }
    } else {
        let root = selector_error(value.root_id, value.workspace, value.path); if root != "" { return root; }
        if value.root_id == value.child_id { return "terminal root and child IDs must differ"; }
        if value.parent != "" && value.parent != value.root_id { return "terminal parent must equal the explicit root ID"; }
    }
    let allowed = allowed_error(value.allowed); if allowed != "" { return allowed; }
    if value.cap_raw != "" { match policy(value.cap_raw) { Ok(_) => {} Err(error) => { return error; } } }
    if value.once_supplied { return question_error(value.once); }
    return "";
}

public flow parse(args: Array<string>) -> Result<Config, string> {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Config { help = true, root_id = "", child_id = "", parent = "", workspace = "", path = "",
            allowed = [], cap_raw = "", once_supplied = false, once = "", latest = false });
    }
    if count(args) < 10 || count(args) > 16 { return Err("expected bounded terminal new or continue arguments"); }
    let mode = args[0]; if mode != "new" && mode != "continue" { return Err("expected terminal new, continue or standalone help"); }
    var id = ""; var child = ""; var parent = ""; var workspace = ""; var path = ""; var allow = ""; var cap = "";
    var once = ""; var supplied_once = false; var latest = false; var supplied_parent = false; var seen: Array<string> = []; var index: usize = 1;
    while index < count(args) limit Iterations(8) {
        let flag = args[index]; index = index + 1;
        for previous in seen limit Iterations(8) { if previous == flag { return Err("duplicate terminal option"); } }
        seen = seen.push(flag);
        if flag == "--latest" {
            if mode != "continue" { return Err("latest parent selection requires terminal continue"); }
            latest = true;
        } else {
            if index >= count(args) { return Err("terminal option value missing"); }
            let value = args[index]; index = index + 1;
            match flag {
                "--id" => { id = value; }
                "--child-id" => { if mode != "new" { return Err("continuation cannot bind another child or third turn"); } child = value; }
                "--parent" => { if mode != "continue" { return Err("new terminal work forbids --parent"); } parent = value; supplied_parent = true; }
                "--workspace" => { workspace = value; }
                "--path" => { path = value; }
                "--allow" => { allow = value; }
                "--cap" => { match policy(value) { Ok(_) => {} Err(error) => { return Err(error); } } cap = value; }
                "--once" => { once = value; supplied_once = true; }
                _ => { return Err("unknown terminal option"); }
            }
        }
    }
    if len(allow) > 97 { return Err("terminal allowlist exceeds 97 characters"); }
    if latest && supplied_parent { return Err("--latest conflicts with explicit --parent"); }
    if mode == "continue" && !latest && parent == "" { return Err("continuation requires explicit --parent or --latest"); }
    let root = if mode == "new" { id } else { parent };
    let child_id = if mode == "new" { child } else { id };
    let result = Config { help = false, root_id = root, child_id = child_id, parent = parent,
        workspace = workspace, path = path, allowed = split(allow, ","), cap_raw = cap,
        once_supplied = supplied_once, once = once, latest = latest };
    let invalid = configuration_error(result, true); if invalid != "" { return Err(invalid); }
    return Ok(result);
}

public flow bind_parent(config: Config, parent: string) -> Result<Config, string> {
    if !config.latest { return Err("latest binding requires unresolved parent selection"); }
    let startup = configuration_error(config, true); if startup != "" { return Err(startup); }
    let result = Config { help = false, root_id = parent, child_id = config.child_id, parent = parent,
        workspace = config.workspace, path = config.path, allowed = config.allowed, cap_raw = config.cap_raw,
        once_supplied = config.once_supplied, once = config.once, latest = false };
    let invalid = configuration_error(result, false); if invalid != "" { return Err(invalid); }
    return Ok(result);
}

// The supported non-TTY transport selects this entry, never an outer input loop.
public flow parse_once(args: Array<string>) -> Result<Config, string> {
    let config = match parse(args) { Ok(value) => value, Err(error) => { return Err(error); } };
    if !config.help && !config.once_supplied { return Err("non-TTY terminal mode requires explicit --once REQUEST"); }
    return Ok(config);
}

// Console returns an empty raw string for EOF; a blank LF/CRLF line is not EOF.
public flow line(raw: string) -> Result<LineCommand, string> {
    if raw == "" { return Ok(LineCommand.Eof); }
    if len(raw) > 130 { return Err("raw terminal line exceeds 128 characters plus LF/CRLF"); }
    var body = ""; var position: usize = 0; var carriage_return = false;
    for character in split(raw, "") limit Iterations(132) {
        if character != "" {
            position = position + 1;
            if carriage_return && character != "\n" { return Err("expected printable ASCII terminal line"); }
            if character == "\r" && position + 1 == len(raw) { carriage_return = true; }
            else if character == "\n" && position == len(raw) { }
            else {
                if !printable(character) { return Err("expected printable ASCII terminal line"); }
                body = body + character;
            }
        }
    }
    if len(body) > 128 { return Err("terminal line exceeds 128 characters before trimming"); }
    let text = trim(body);
    match text {
        "/help" => { return Ok(LineCommand.Help); }
        "/show" => { return Ok(LineCommand.Show); }
        "/exit" => { return Ok(LineCommand.Exit); }
        _ => {}
    }
    if starts_with(text, "/") { return Err("unknown terminal command; use /help, /show or /exit"); }
    let invalid = question_error(text); if invalid != "" { return Err(invalid); }
    return Ok(LineCommand.Request(text));
}

public flow work_request(config: Config, turn: i32, request: string) -> Result<TurnRequest, string> {
    let invalid = configuration_error(config, false); if invalid != "" { return Err(invalid); }
    if turn != 1 && turn != 2 { return Err("terminal work forbids a third or invalid turn"); }
    if turn == 1 && config.parent != "" { return Err("explicit continuation starts at the second turn"); }
    if config.once_supplied && ((config.parent == "" && turn != 1) || (config.parent != "" && turn != 2)) { return Err("one-shot startup permits only its selected turn"); }
    if config.once_supplied && request != config.once { return Err("one-shot request differs from its startup binding"); }
    let invalid_request = question_error(request); if invalid_request != "" { return Err(invalid_request); }
    let id = if turn == 1 { config.root_id } else { config.child_id };
    let selected = Selector { id = id, workspace = config.workspace, path = config.path };
    let cap = if config.cap_raw == "" { turn_caps() } else { match policy(config.cap_raw) { Ok(value) => value, Err(error) => { return Err(error); } } };
    let value = WorkRequest { selected = selected, request = request, allowed = config.allowed, cap = cap };
    let result = if turn == 1 { TurnRequest.New(value) } else { TurnRequest.Continue(ContinueRequest { parent = config.root_id, work = value }) };
    let error = request_error(result); if error != "" { return Err(error); }
    return Ok(result);
}

public flow show_selector(config: Config, turn: i32) -> Result<Selector, string> {
    let invalid = configuration_error(config, false); if invalid != "" { return Err(invalid); }
    if turn != 1 && turn != 2 { return Err("terminal show requires a bound first or second turn"); }
    let id = if turn == 1 { config.root_id } else { config.child_id };
    return Ok(Selector { id = id, workspace = config.workspace, path = config.path });
}
