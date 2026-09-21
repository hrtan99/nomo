module nomo.workspace;

import std.fs.{Region, WorkspacePath, IOError, path, read_bytes, list};
import std.bytes.len as byte_len;
import std.codec.text.{utf8_decode, Strict};
import std.text.{len, split, contains, starts_with, to_string_usize};
import std.collections.len as count;
import nomo.text.printable;

public type ReadOnlyRoot;
impl ReadOnlyRoot ~ Region;
public type Outcome = { status: string, text: string, scanned: usize };

public flow outcome(status: string, text: string, scanned: usize) -> Outcome {
    return Outcome { status = status, text = text, scanned = scanned };
}

// Conservative, canonical relative names only; the Host still enforces the region.
public flow valid_path(name: string) -> bool {
    if len(name) == 0 || len(name) > 128 || starts_with(name, "/") { return false; }
    let parts = split(name, "/");
    if count(parts) > 2 { return false; }
    for part in parts limit Iterations(2) {
        if part == "" || part == "." || part == ".." { return false; }
        for character in split(part, "") limit Iterations(130) {
            if character != "" && !contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", character) { return false; }
        }
    }
    return true;
}

flow target(name: string) -> WorkspacePath<ReadOnlyRoot> {
    let checked: Result<WorkspacePath<ReadOnlyRoot>, IOError> = path<ReadOnlyRoot>(name);
    return match checked {
        Ok(value) => value,
        Err(_) => abort("read-only path construction refused"),
    };
}

// The accepted Host reads the whole file. This is a POST-read processing bound,
// not an allocation bound. Enable only for an externally admitted small fixture.
public flow read_file(name: string) -> Outcome {
    if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    let bytes = read_bytes(target(name));
    if byte_len(bytes) > 2048 { return outcome("refused", "file exceeds 2048 bytes (post-read check)", 0); }
    let decoded = utf8_decode(bytes, Strict);
    return match decoded {
        Err(_) => outcome("unsupported", "file is not UTF-8", 0),
        Ok(text) => outcome("complete", text, byte_len(bytes)),
    };
}

// Opaque paths can be counted but this accepted API exposes no name projection.
// Do not invent names or mistake a count for the requested named-entry listing.
public flow list_directory(name: string) -> Outcome {
    if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    let entries = list(target(name));
    if count(entries) > 16 { return outcome("refused", "directory exceeds 16 entries (post-list check)", 0); }
    return outcome("unsupported", "named listing unavailable: opaque WorkspacePath; entries=" + to_string_usize(count(entries)), 0);
}

// Search explicit files, never recurse or discover ambient paths. At most two
// 2 KiB files are scanned, with 128 lines/file, 8 matches and 1024 output chars.
public flow search_files(names: Array<string>, literal: string) -> Outcome {
    if count(names) == 0 || count(names) > 2 { return outcome("refused", "search requires 1..2 explicit files", 0); }
    if len(literal) == 0 || len(literal) > 64 || !printable(literal) { return outcome("refused", "literal must be 1..64 printable ASCII characters", 0); }
    for name in names limit Iterations(2) {
        if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    }
    if count(names) == 2 && names[0] == names[1] { return outcome("refused", "duplicate search file", 0); }
    var output = "";
    var scanned: usize = 0;
    var matches: usize = 0;
    for name in names limit Iterations(2) {
        let file = read_file(name);
        if file.status != "complete" { return outcome(file.status, name + ": " + file.text, scanned); }
        let lines = split(file.text, "\n");
        if count(lines) > 128 { return outcome("refused", "file exceeds 128 lines", scanned); }
        scanned = scanned + file.scanned;
        var line: usize = 0;
        for text in lines limit Iterations(128) {
            line = line + 1;
            if contains(text, literal) {
                let entry = name + ":" + to_string_usize(line) + "\n";
                if matches >= 8 || len(output) + len(entry) > 1024 { return outcome("truncated", output, scanned); }
                output = output + entry;
                matches = matches + 1;
            }
        }
    }
    return outcome("complete", output, scanned);
}

// Terminal/history text stays one line. Marker encoding escapes '<' as <LT>,
// so a literal marker cannot impersonate LF/CR/TAB. Other controls are refused.
public flow display(result: Outcome) -> Outcome {
    if len(result.text) > 1024 { return outcome("refused", "result exceeds 1024 characters", result.scanned); }
    var escaped = "";
    for character in split(result.text, "") limit Iterations(1026) {
        if character == "\n" { escaped = escaped + "<LF>"; }
        else {
            if character == "\r" { escaped = escaped + "<CR>"; }
            else {
                if character == "\t" { escaped = escaped + "<TAB>"; }
                else {
                    if character == "<" { escaped = escaped + "<LT>"; }
                    else {
                        if !printable(character) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
                        escaped = escaped + character;
                    }
                }
            }
        }
    }
    if len(escaped) > 1024 { return outcome("refused", "escaped result exceeds 1024 characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}
