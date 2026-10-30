module nomo.entry.terminal_entry;

import std.io.{println, read_line};
import std.text.to_string_i32;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;
import nomo.cli.terminal_args.{Config, LineCommand, parse, parse_once, bind_parent, line, work_request, show_selector};
import nomo.ui.terminal_session.{State, fresh, turn, work_error, after_turn, state_line, request_line};
import nomo.tools.edit_encoding.json;
import nomo.session.work_chain.{turn_caps, values};
import nomo.entry.work_chain_entry.{execute_application_detailed, project_outcome, present_detailed_outcome, inspect_application, present_show};
import nomo.session.work_chain_usecase.{TerminalWork, TerminalRead, WorkOutcome, dispatch, read_selected, read_latest, latest_error};
import nomo.entry.terminal_help.help;
import nomo.session.work_chain_store.latest_parent;

flow refused(error: string) -> i32 {
    let encoded = match json([error]) { Ok(value) => value, Err(_) => "[\"terminal diagnostic encoding refused\"]" };
    println("ERROR " + encoded); return 1;
}
flow selected_config(config: Config) -> Result<Config, string> {
    if !config.latest { return Ok(config); }
    let parent = match read_latest(config.workspace, config.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    return bind_parent(config, parent);
}
flow policy(config: Config) -> string {
    if config.cap_raw != "" { return config.cap_raw; }
    var result = "";
    for value in values(turn_caps()) limit Iterations(10) {
        if result != "" { result = result + ","; } result = result + to_string_i32(value);
    }
    return result;
}
flow display(config: Config, state: State) -> Result<bool, string> {
    let rendered = match state_line(state, config.root_id, config.child_id, config.workspace, config.path, policy(config), config.once_supplied) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    println(rendered); return Ok(true);
}
flow request(config: Config, state: State, text: string) -> Result<State, string> {
    let invalid = work_error(state); if invalid != "" { return Err(invalid); }
    let operation = match work_request(config, turn(state), text) { Ok(value) => value, Err(error) => { return Err(error); } };
    let rendered = match request_line(text) { Ok(value) => value, Err(error) => { return Err(error); } };
    println(rendered);
    let outcome = dispatch(operation);
    let completed = match outcome { WorkOutcome.Completed => true, WorkOutcome.Stopped(_) => false };
    let next = match after_turn(state, completed, config.once_supplied) { Ok(value) => value, Err(error) => { return Err(error); } };
    match display(config, next) { Ok(_) => {} Err(error) => { return Err(error); } }
    if !completed { return Err("work stopped; inspect captured work and journal state before any further action"); }
    return Ok(next);
}
flow show(config: Config, state: State) -> i32 {
    // Explicit selectors only. Missing/captured records never advance control state.
    let root = match show_selector(config, 1) { Ok(value) => value, Err(error) => { return refused(error); } };
    if present_show(read_selected(root)) != 0 { return 1; }
    if turn(state) == 2 {
        let child = match show_selector(config, 2) { Ok(value) => value, Err(error) => { return refused(error); } };
        if present_show(read_selected(child)) != 0 { return 1; }
    }
    return 0;
}
public flow run_with_operations(args: Array<string>) -> i32 ![Console, TerminalWork.execute, TerminalRead.show, TerminalRead.latest, Error<IndexError>, Error<ConsoleError>] {
    let parsed = match parse(args) { Ok(value) => value, Err(error) => { return refused(error); } };
    if parsed.help { return help([]); }
    let config = match selected_config(parsed) { Ok(value) => value, Err(error) => { return refused(error); } };
    var state = fresh(config.parent != "");
    match display(config, state) { Ok(_) => {} Err(error) => { return refused(error); } }
    if config.once_supplied {
        match request(config, state, config.once) { Ok(_) => { return 0; } Err(error) => { return refused(error); } }
    }
    var lines: i32 = 0;
    while lines < 32 limit Iterations(32) {
        println("REQUEST /help /show /exit");
        let raw = read_line(); lines = lines + 1;
        // Only malformed input recovers; admitted work errors still stop.
        match line(raw) {
            Err(error) => { let refused_status = refused(error); }
            Ok(command) => {
                match command {
                    LineCommand.Eof => { println("STOP EOF; captured state is preserved"); return 0; }
                    LineCommand.Exit => { println("STOP exit; captured state is preserved"); return 0; }
                    LineCommand.Help => { if help([]) != 0 { return 1; } }
                    LineCommand.Show => { if show(config, state) != 0 { return 1; } }
                    LineCommand.Request(text) => {
                        state = match request(config, state, text) { Ok(value) => value, Err(error) => { return refused(error); } };
                        if work_error(state) != "" { println("STOP selected work complete; no further request in this process"); return 0; }
                    }
                }
            }
        }
    }
    return refused("terminal input limit reached; inspect captured state; no further request in this process");
}

// No outer request read: missing --once is refused before any work admission.
public flow run_once_with_operations(args: Array<string>) -> i32 ![Console, TerminalWork.execute, TerminalRead.show, TerminalRead.latest, Error<IndexError>, Error<ConsoleError>] {
    let parsed = match parse_once(args) { Ok(value) => value, Err(error) => { return refused(error); } };
    if parsed.help { return help([]); }
    let config = match selected_config(parsed) { Ok(value) => value, Err(error) => { return refused(error); } };
    let state = fresh(config.parent != "");
    match display(config, state) { Ok(_) => {} Err(error) => { return refused(error); } }
    return match request(config, state, config.once) { Ok(_) => 0, Err(error) => refused(error) };
}

flow latest_application(workspace: string, path: string) -> Result<string, string> {
    let invalid = latest_error(workspace, path); if invalid != "" { return Err(invalid); }
    return latest_parent(workspace, path);
}
flow production(args: Array<string>, once: bool) -> i32 {
    return handle { if once { run_once_with_operations(args) } else { run_with_operations(args) } } with {
        TerminalWork.execute(request) => { let detailed = execute_application_detailed(request); let status = present_detailed_outcome(detailed); resume project_outcome(detailed); }
        TerminalRead.show(selected) => { resume inspect_application(selected); }
        TerminalRead.latest(workspace, path) => { resume latest_application(workspace, path); }
    };
}
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return production(args, false); }
public flow run_once(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] { return production(args, true); }
