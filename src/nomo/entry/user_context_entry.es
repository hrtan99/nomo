module nomo.entry.user_context_entry;

import std.collections.len as count;
import std.text.{char_count as len, starts_with, trim};
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import std.io.{println, read_line};
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.runtime.error.IndexError;
import std.effects.Fs;
import nomo.cli.work_chain_args.{Input, parse};
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.edit_encoding.object;
import nomo.entry.work_chain_entry.execute_user_context;

public type Selection = { root: string, mode: string, accepted: bool, input: Input };

flow root_error(root: string) -> string {
    if len(root) == 0 || len(root) > 512 || !starts_with(root, "/") { return "read root must be an absolute path of at most 512 characters"; }
    for codepoint in std.text.chars(root) limit Iterations(514) { let character = std.text.from_char(codepoint);
        if character != "" {
            let bytes = utf8_encode(character);
            if byte_count(bytes) == 1 && (bytes[0] < 32 || bytes[0] == 127) { return "read root must not contain control characters"; }
        }
    }
    return "";
}

public flow selection(args: Array<string>) -> Result<Selection, string> {
    if count(args) < 14 || count(args) > 19 || args[0] != "--read-root" || args[2] != "--input-mode" {
        return Err("expected --read-root ROOT --input-mode MODE and bounded new-work options");
    }
    let root = args[1]; let mode = args[3];
    let invalid = root_error(root); if invalid != "" { return Err(invalid); }
    if mode != "tty" && mode != "non-tty" { return Err("invalid input mode"); }
    var rest: Array<string> = []; var accepted = false; var index: usize = 4;
    while index < count(args) limit Iterations(16) {
        let flag = args[index]; index = index + 1;
        if flag == "--accept-read-root" {
            if accepted { return Err("duplicate --accept-read-root"); }
            accepted = true;
        } else {
            if index >= count(args) { return Err("work option value missing"); }
            rest = rest.push(flag).push(args[index]); index = index + 1;
        }
    }
    if mode == "non-tty" && !accepted { return Err("non-TTY user-context work requires --accept-read-root"); }
    if mode == "tty" && accepted { return Err("TTY user-context work requires fresh interactive confirmation"); }
    let input = match parse(rest, false) { Ok(value) => value, Err(error) => { return Err(error); } };
    if input.work.edit.help || input.work.edit.path != "demo/value.txt" { return Err("user-context work edits only the prepared demo/value.txt fixture"); }
    return Ok(Selection { root = root, mode = mode, accepted = accepted, input = input });
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let selected = match selection(args) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    var second = ""; if count(selected.input.work.allowed) == 2 { second = selected.input.work.allowed[1]; }
    let shown = match object(["root", "file1", "file2"], [selected.root, selected.input.work.allowed[0], second]) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; }
    };
    println("READ CONTEXT " + shown);
    println("The selected directory is already mounted read-only and is visible to the native process. The file allowlist is enforced by Nomo, not by a per-file OS mount.");
    println("An allowed path may follow a symbolic link inside the root; a hard link may expose content also linked elsewhere. Files can change during reading; this is not an atomic snapshot.");
    println("Allowed file contents may be sent to the configured model. This mode edits only the prepared demo file and cannot continue or resume another turn.");
    if selected.mode == "tty" {
        println("Allow this read context? Type yes to continue:");
        let answer = read_line();
        if answer == "" || trim(answer) != "yes" { println("REFUSED read-context consent was not given"); return 1; }
    }
    return execute_user_context(selected.input);
}
