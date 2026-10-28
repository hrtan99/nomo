module nomo.entry.terminal_entry;

import std.io.{println, read_line};
import std.text.to_string_i32;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;
import nomo.cli.terminal_args.{Config, LineCommand, parse, parse_once, bind_parent, line, work_arguments, show_arguments};
import nomo.ui.terminal_session.{State, fresh, turn, work_error, after_turn, state_line, request_line};
import nomo.tools.edit_encoding.json;
import nomo.session.work_chain.{turn_caps, values};
import nomo.entry.work_chain_entry.{run_new, run_continue, run_show};
import nomo.entry.terminal_help.help;
import nomo.session.work_chain_store.latest_parent;

flow refused(error: string) -> i32 {
    let encoded = match json([error]) { Ok(value) => value, Err(_) => "[\"terminal diagnostic encoding refused\"]" };
    println("ERROR " + encoded); return 1;
}
flow selected_config(config: Config) -> Result<Config, string> {
    if !config.latest { return Ok(config); }
    let parent = match latest_parent(config.workspace, config.path) { Ok(value) => value, Err(error) => { return Err(error); } };
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
    let args = match work_arguments(config, turn(state), text) { Ok(value) => value, Err(error) => { return Err(error); } };
    let rendered = match request_line(text) { Ok(value) => value, Err(error) => { return Err(error); } };
    println(rendered);
    let status = if turn(state) == 1 { run_new(args) } else { run_continue(args) };
    let next = match after_turn(state, status == 0, config.once_supplied) { Ok(value) => value, Err(error) => { return Err(error); } };
    match display(config, next) { Ok(_) => {} Err(error) => { return Err(error); } }
    if status != 0 { return Err("work stopped; inspect captured work and journal state before any further action"); }
    return Ok(next);
}
flow show(config: Config, state: State) -> i32 {
    // Explicit selectors only. Missing/captured records never advance control state.
    let root = match show_arguments(config, 1) { Ok(value) => value, Err(error) => { return refused(error); } };
    if run_show(root) != 0 { return 1; }
    if turn(state) == 2 {
        let child = match show_arguments(config, 2) { Ok(value) => value, Err(error) => { return refused(error); } };
        if run_show(child) != 0 { return 1; }
    }
    return 0;
}
public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
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
        let command = match line(raw) { Ok(value) => value, Err(error) => { return refused(error); } };
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
    return refused("terminal input limit reached; inspect captured state; no further request in this process");
}

// No outer request read: missing --once is refused before any work admission.
public flow run_once(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let parsed = match parse_once(args) { Ok(value) => value, Err(error) => { return refused(error); } };
    if parsed.help { return help([]); }
    let config = match selected_config(parsed) { Ok(value) => value, Err(error) => { return refused(error); } };
    let state = fresh(config.parent != "");
    match display(config, state) { Ok(_) => {} Err(error) => { return refused(error); } }
    return match request(config, state, config.once) { Ok(_) => 0, Err(error) => refused(error) };
}
