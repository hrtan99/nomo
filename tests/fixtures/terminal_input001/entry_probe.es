module app.terminal_input_probe;

import std.io.println;
import std.text.to_string_i32;
import std.collections.len as count;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;
import nomo.entry.terminal_entry.run as terminal;
import nomo.entry.terminal_entry.run_once as terminal_once;
import nomo.entry.terminal_entry.{run_with_operations, run_once_with_operations};
import nomo.session.work_chain_usecase.{WorkRequest, ContinueRequest, TurnRequest, WorkOutcome, WorkStop, CapturedShow, TerminalWork, TerminalRead, work};
import nomo.session.work_chain.{turn_caps, initial};
import nomo.tools.edit_contract.Selector;
import nomo.tools.edit_encoding.json;
import nomo.harness.harness_work_contract.Ledger;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_edit_contract.fresh as edit_fresh;
import nomo.entry.work_chain_entry.present_outcome;

// Calls the actual entry without replacing its controller or Console actions.
// The broad row acknowledges the entry's existing static contract; the test
// profile permits only Console and denies every business authority at runtime.
flow returned(status: i32) -> i32 {
    println("TERMINAL_INPUT_RETURN " + to_string_i32(status));
    return 0;
}

public flow interactive(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    return returned(terminal(args));
}

public flow once(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    return returned(terminal_once(args));
}

// Deterministic source handlers; fake Completed does not establish durability.
flow encoded(fields: Array<string>) -> string {
    return match json(fields) { Ok(value) => value, Err(error) => { abort(error); } };
}
flow stopped_value() -> WorkOutcome {
    let state = Ledger { read = ReadLedger { steps = 2, calls = 1, tokens = 2048, tools = 0, scan = 0 }, edit = edit_fresh() };
    return WorkOutcome.Stopped(WorkStop { state = state, error = "v2 work-chain commit unknown; admission retained, no retry" });
}
flow fake_work(mode: string, request: TurnRequest) -> WorkOutcome {
    let value = work(request);
    let next = match request { TurnRequest.New(_) => false, TurnRequest.Continue(_) => true };
    let parent = match request { TurnRequest.New(_) => "", TurnRequest.Continue(item) => item.parent };
    let id = if next { "child-op" } else { "root-op" };
    let selected = Selector { id = id, workspace = "owned", path = "target.txt" };
    let expected = WorkRequest { selected = selected, request = if next { "second" } else { "first" }, allowed = ["context.txt", "other.txt"], cap = turn_caps() };
    if value != expected || parent != (if next { "root-op" } else { "" }) { abort("D4 full typed work binding changed"); }
    println("WORK_PORT " + encoded([if next { "continue" } else { "new" }, id, parent, value.request]));
    let result = if mode == "stop" || mode == "unknown" || (mode == "stop-second" && next) { stopped_value() } else { WorkOutcome.Completed };
    let status = present_outcome(result);
    return result;
}
flow fake_show(mode: string, selected: Selector) -> Result<Option<CapturedShow>, string> {
    if selected.workspace != "owned" || selected.path != "target.txt" || (selected.id != "root-op" && selected.id != "child-op") { abort("D4 read selector binding changed"); }
    println("READ_PORT " + encoded([selected.id, selected.workspace, selected.path]));
    if mode == "read-fail" { return Err("bounded read refused"); }
    if mode == "captured" {
        let row = match initial(selected.id, selected.workspace, selected.path, "captured only", ["context.txt", "other.txt"], turn_caps()) { Ok(value) => value, Err(error) => { abort(error); } };
        return Ok(Some(CapturedShow { row = row, journal = None() }));
    }
    return Ok(None());
}
flow fake_latest(mode: string, workspace: string, path: string) -> Result<string, string> {
    if workspace != "owned" || path != "target.txt" { abort("D4 latest binding changed"); }
    println("LATEST_PORT " + encoded([workspace, path]));
    return Ok(if mode == "latest-collision" { "child-op" } else { "root-op" });
}
public flow typed(args: Array<string>) -> i32 ![Console, Error<IndexError>, Error<ConsoleError>] {
    let mode = args[0]; var selected: Array<string> = []; var index: usize = 1;
    while index < count(args) limit Iterations(20) { selected = selected.push(args[index]); index = index + 1; }
    let result = handle { if mode == "once" || mode == "once-stop" || mode == "once-missing" { run_once_with_operations(selected) } else { run_with_operations(selected) } } with {
        TerminalWork.execute(request) => { resume fake_work(if mode == "once-stop" { "stop" } else { mode }, request); }
        TerminalRead.show(selector) => { resume fake_show(mode, selector); }
        TerminalRead.latest(workspace, path) => { resume fake_latest(mode, workspace, path); }
    };
    return returned(result);
}

// Static probes only: these expose the same production-independent core.
public flow unbound_interactive(args: Array<string>) -> i32 ![Console, TerminalWork.execute, TerminalRead.show, TerminalRead.latest, Error<IndexError>, Error<ConsoleError>] { return run_with_operations(args); }
public flow unbound_once(args: Array<string>) -> i32 ![Console, TerminalWork.execute, TerminalRead.show, TerminalRead.latest, Error<IndexError>, Error<ConsoleError>] { return run_once_with_operations(args); }
