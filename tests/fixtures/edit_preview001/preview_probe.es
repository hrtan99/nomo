module app.preview_probe;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.split;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.ui.edit_diff.render;
import nomo.tools.edit_file.{EditableRoot, prepare_original};
import nomo.entry.edit_coordinator.{Selector, Approval, execute};

type Check = { label: string, before: string, after: string, expected: string, error: string };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }

flow terminal_safe(value: string) -> bool {
    let bytes = utf8_encode(value);
    if byte_count(bytes) > 8192 { return false; }
    var index: usize = 0;
    while index < byte_count(bytes) limit Iterations(8192) {
        let number = bytes[index];
        if number != 10 && (number < 32 || number > 126) { return false; }
        index = index + 1;
    }
    return true;
}

flow evaluate(item: Check) -> bool {
    return match render(item.before, item.after) {
        Ok(value) => item.error == "" && value == item.expected && terminal_safe(value),
        Err(error) => item.error != "" && error == item.error,
    };
}

public flow pure_probe() -> bool {
    for item in checks() limit Iterations(32) { if !evaluate(item) { return false; } }
    return true;
}

public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(32) {
        if !evaluate(item) { println("FAIL " + item.label); abort("edit preview golden failed"); }
        println("PASS " + item.label);
    }
    return 0;
}

// Source denial, not a native approval exercise. Calling the real execute
// controller proves this denial returns before its journal/File branches.
public flow denied(args: Array<string>) -> i32 ![Console, Memory, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let prepared = match prepare_original("docs/note.txt", "head\nold\nend\n", "old", "new") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
    let selector = Selector { id = "preview-denied", workspace = "preview-fixture", path = "docs/note.txt" };
    let answer = execute(selector, prepared) with {
        Approval.request(reason) => {
            println("SOURCE_APPROVAL_DENIED " + reason);
            resume false;
        }
    };
    match answer {
        Err(error) => { if error != "native approval denied; no intent or File write" { abort(error); } }
        Ok(_) => { abort("source denial unexpectedly completed edit"); }
    }
    println("PASS source denial preserves preview and stops before journal");
    return 0;
}
