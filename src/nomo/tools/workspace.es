module nomo.tools.workspace;

import std.fs.{Region, WorkspacePath, IOError, ReadLimitError, path, read_bytes_limited, list};
import std.bytes.len as byte_len;
import std.codec.text.{utf8_decode, Strict};
import std.text.{len, split, contains, to_string_usize};
import std.collections.len as count;
import nomo.core.text.printable;
import nomo.tools.path_policy.valid_path as canonical_path;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.read_contract.{NomoRead, NomoSearch};
public import nomo.tools.read_contract.{Outcome, outcome, display};

public type ReadOnlyRoot;
impl ReadOnlyRoot ~ Region;
// Conservative, canonical relative names only; the Host still enforces the region.
public flow valid_path(name: string) -> bool {
    return canonical_path(name);
}

flow target(name: string) -> WorkspacePath<ReadOnlyRoot> {
    let checked: Result<WorkspacePath<ReadOnlyRoot>, IOError> = path<ReadOnlyRoot>(name);
    return match checked {
        Ok(value) => value,
        Err(_) => abort("read-only path construction refused"),
    };
}

// The Host enforces the byte cap while reading; overflow never returns a prefix.
public flow read_file(name: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoRead<ReadOnlyRoot> {
    if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    return handle {
        let bytes = read_bytes_limited(target(name), 2048);
        let decoded = utf8_decode(bytes, Strict);
        match decoded {
            Err(_) => outcome("unsupported", "file is not UTF-8", 0),
            Ok(text) => outcome("complete", text, byte_len(bytes)),
        }
    } with {
        Error<ReadLimitError>.raise(ReadLimitError.LimitExceeded(maximum)) => {
            if maximum != 2048 { abort("unexpected workspace read limit"); }
            finish outcome("refused", "file exceeds 2048 bytes", 0);
        }
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
public flow search_files(names: Array<string>, literal: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoSearch<ReadOnlyRoot> {
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
