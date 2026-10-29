module app.terminal_input_probe;

import std.io.println;
import std.text.to_string_i32;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;
import nomo.entry.terminal_entry.run as terminal;
import nomo.entry.terminal_entry.run_once as terminal_once;

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
