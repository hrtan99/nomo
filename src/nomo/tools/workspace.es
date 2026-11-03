module nomo.tools.workspace;

import std.fs.{Region, WorkspacePath, IOError, ReadLimitError, ListLimitError, path, root, relative_name, list_limited, stat, read_bytes_limited, list};
import std.bytes.len as byte_len;
import std.codec.text.{utf8_decode, Strict};
import std.text.{len, split, contains, starts_with, to_string_usize};
import std.agent.message.Message;
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

// Discovery is bounded and rooted in the currently selected read-only region.
type DiscoveredFileInfo = { is_file: bool, is_dir: bool, len: u64 };
flow excluded(name: string) -> bool {
    for part in split(name, "/") limit Iterations(8) {
        if starts_with(part, ".") || part == "node_modules" || part == "target" || part == "build" || part == "dist" || part == "vendor" { return true; }
    }
    return false;
}
public flow discover() -> Result<Array<string>, string> ![Fs.list<ReadOnlyRoot>, Fs.stat<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] {
    return handle {
        var dirs: Array<WorkspacePath<ReadOnlyRoot>> = [root<ReadOnlyRoot>()]; var depths: Array<usize> = [0]; var files: Array<string> = []; var i: usize = 0;
        while i < count(dirs) limit Iterations(64) {
            let entries = list_limited(dirs[i], 256, 32768);
            for entry in entries limit Iterations(256) {
                let name = relative_name(entry);
                if !excluded(name) && valid_path(name) {
                    let projected: Option<Message<DiscoveredFileInfo>> = Message.new(stat(entry)).cast<DiscoveredFileInfo>();
                    let info = match projected { Some(value) => value.body, None() => { return Err("file metadata unavailable"); } };
                    if info.is_file { if count(files) >= 256 { return Err("discovery exceeds 256 files; select a narrower root"); } files = files.push(name); }
                    else if info.is_dir && depths[i] < 4 { if count(dirs) >= 64 { return Err("discovery exceeds 64 directories; select a narrower root"); } dirs = dirs.push(entry); depths = depths.push(depths[i] + 1); }
                }
            }
            i = i + 1;
        }
        return Ok(files);
    } with { Error<ListLimitError>.raise(_) => { finish Err("directory exceeds discovery limit; select a narrower root"); } };
}

// The Host enforces the byte cap while reading; overflow never returns a prefix.
flow read_bounded(name: string, bound: usize) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] {
    if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    return handle {
        let bytes = read_bytes_limited(target(name), bound);
        let decoded = utf8_decode(bytes, Strict);
        match decoded {
            Err(_) => outcome("unsupported", "file is not UTF-8", 0),
            Ok(text) => outcome("complete", text, byte_len(bytes)),
        }
    } with {
        Error<ReadLimitError>.raise(ReadLimitError.LimitExceeded(maximum)) => {
            if maximum != bound { abort("unexpected workspace read limit"); }
            finish outcome("refused", if bound == 16384 { "file exceeds 16384 bytes" } else { if bound == 2048 { "file exceeds 2048 bytes" } else { "file exceeds remaining scan allowance" } }, 0);
        }
    };
}

public flow read_file(name: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoRead<ReadOnlyRoot> {
    return read_bounded(name, 16384);
}

// Legacy scripted callers retain their original 2 KiB per-file scan reservation.
public flow read_legacy(name: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoRead<ReadOnlyRoot> {
    return read_bounded(name, 2048);
}

// Opaque paths can be counted but this accepted API exposes no name projection.
// Do not invent names or mistake a count for the requested named-entry listing.
public flow list_directory(name: string) -> Outcome {
    if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    let entries = list(target(name));
    if count(entries) > 16 { return outcome("refused", "directory exceeds 16 entries (post-list check)", 0); }
    return outcome("unsupported", "named listing unavailable: opaque WorkspacePath; entries=" + to_string_usize(count(entries)), 0);
}

// Search explicit files, never recurse or discover ambient paths. At most four
// files and 16384 delivered bytes total, with 16384 lines/file and 8 matches.
// A Host overflow check may probe one additional byte, never return a prefix.
flow search_with(names: Array<string>, literal: string, maximum: usize) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] {
    if count(names) == 0 || count(names) > 4 { return outcome("refused", "search requires 1..4 explicit files", 0); }
    if len(literal) == 0 || len(literal) > 64 || !printable(literal) { return outcome("refused", "literal must be 1..64 printable ASCII characters", 0); }
    for name in names limit Iterations(4) {
        if !valid_path(name) { return outcome("refused", "invalid relative path", 0); }
    }
    var i: usize = 0;
    while i < count(names) limit Iterations(4) {
        var j = i + 1;
        while j < count(names) limit Iterations(4) {
            if names[i] == names[j] { return outcome("refused", "duplicate search file", 0); }
            j = j + 1;
        }
        i = i + 1;
    }
    var output = "";
    var scanned: usize = 0;
    var matches: usize = 0;
    for name in names limit Iterations(4) {
        let remaining = maximum - scanned;
        let per_file = if maximum == 4096 { 2048 } else { 16384 };
        let bound = if remaining < per_file { remaining } else { per_file };
        let file = read_bounded(name, bound);
        if file.status != "complete" { return outcome(file.status, name + ": " + file.text, scanned); }
        let lines = split(file.text, "\n");
        let line_limit = if maximum == 4096 { 128 } else { 16385 };
        if count(lines) > line_limit { return outcome("refused", "file exceeds line limit", scanned); }
        scanned = scanned + file.scanned;
        var line: usize = 0;
        for text in lines limit Iterations(16385) {
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

public flow search_files(names: Array<string>, literal: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoSearch<ReadOnlyRoot> {
    return search_with(names, literal, 16384);
}
public flow search_legacy(names: Array<string>, literal: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoSearch<ReadOnlyRoot> {
    return search_with(names, literal, 4096);
}
