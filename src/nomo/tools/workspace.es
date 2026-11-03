module nomo.tools.workspace;

import std.fs.{Region, WorkspacePath, IOError, ReadLimitError, ListLimitError, path, root, relative_name, list_limited, stat, read_bytes_limited, list};
import std.bytes.len as byte_len;
import std.codec.text.{utf8_decode, Strict};
import std.text.{len, split, contains, starts_with, to_string_usize};
import std.agent.message.Message;
import std.collections.len as count;
import nomo.core.read_text.search_literal;
public import nomo.tools.path_policy.valid_path;
import nomo.model.tool_context.candidate_error;
import std.fs.IOError as FileError;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import nomo.tools.read_contract.{NomoRead, NomoSearch};
public import nomo.tools.read_contract.{Outcome, outcome, display};

public type ReadOnlyRoot;
impl ReadOnlyRoot ~ Region;
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
        let excluded = "|.git|.hg|.svn|.bzr|.venv|.tox|.cache|.mypy_cache|.pytest_cache|.ssh|.aws|.gnupg|.netrc|node_modules|target|build|dist|vendor|";
        if contains(excluded, "|" + part + "|") { return true; }
        if part == ".env" || (starts_with(part, ".env.") && part != ".env.example" && part != ".env.sample") { return true; }
    }
    return false;
}
public type Discovery = { files: Array<string>, page: usize, more: bool };
public flow discover(page: usize) -> Result<Discovery, string> ![Console, Fs.list<ReadOnlyRoot>, Fs.stat<ReadOnlyRoot>, Error<FileError>, Error<ConsoleError>, Error<IndexError>] {
    return handle {
        var dirs: Array<WorkspacePath<ReadOnlyRoot>> = [root<ReadOnlyRoot>()]; var depths: Array<usize> = [0]; var files: Array<string> = []; var i: usize = 0;
        var deep = false; var unsupported = false; var seen: usize = 0; var more = false;
        while i < count(dirs) && !more limit Iterations(512) {
            let entries = list_limited(dirs[i], 1024, 131072);
            for entry in entries limit Iterations(1024) {
                let name = relative_name(entry);
                if !excluded(name) {
                    if !valid_path(name) { unsupported = true; }
                    else {
                        let projected: Option<Message<DiscoveredFileInfo>> = Message.new(stat(entry)).cast<DiscoveredFileInfo>();
                        let info = match projected { Some(value) => value.body, None() => { return Err("file metadata unavailable"); } };
                        if info.is_file {
                            if seen >= page * 256 { if count(files) == 256 { more = true; break; } files = files.push(name); }
                            seen = seen + 1;
                        }
                        else if info.is_dir && depths[i] < 7 { if count(dirs) >= 512 { return Err("discovery exceeds 512 directories; select a narrower root"); } dirs = dirs.push(entry); depths = depths.push(depths[i] + 1); }
                        else if info.is_dir { deep = true; } else { unsupported = true; }
                    }
                }
            }
            i = i + 1;
        }
        if deep { println("DISCOVERY INCOMPLETE: directories beyond seven levels were not visited."); }
        if unsupported { println("DISCOVERY INCOMPLETE: unsupported names or file types were omitted."); }
        if count(files) == 0 { return Err("discovery page is empty"); }
        println("DISCOVERY PAGE " + to_string_usize(page) + (if more { ": more candidates remain." } else { ": no later candidates found within discovery bounds." }));
        return Ok(Discovery { files = files, page = page, more = more });
    } with { Error<ListLimitError>.raise(_) => { finish Err("directory exceeds 1024 entries or 131072 name bytes; select a narrower root"); } };
}

// Select an explicit list or a bounded discovery page. All membership is revalidated per turn.
public flow selection(raw: string) -> Result<Discovery, string> {
    if raw == "*" { return discover(0); }
    let pages = ["*0", "*1", "*2", "*3", "*4", "*5", "*6", "*7"];
    var page: usize = 0;
    for token in pages limit Iterations(8) { if raw == token { return discover(page); } page = page + 1; }
    let names = split(raw, ",");
    if count(names) > 4 { return Err("explicit selection supports up to four files"); }
    return Ok(Discovery { files = names, page = 0, more = false });
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
            finish outcome("refused", if bound == 16384 { "file exceeds 16384 bytes" } else { if bound == 65536 { "file exceeds 65536 bytes" } else { if bound == 2048 { "file exceeds 2048 bytes" } else { "file exceeds remaining scan allowance" } } }, 0);
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
    if count(names) == 0 || count(names) > (if maximum == 4194304 { 256 } else { 4 }) { return outcome("refused", "search file count exceeds scope", 0); }
    if !search_literal(literal) { return outcome("refused", "literal must be 1..64 safe UTF-8 bytes", 0); }
    let invalid = candidate_error(names); if invalid != "" { return outcome("refused", invalid, 0); }
    var output = "";
    var scanned: usize = 0;
    var consumed: usize = 0;
    var matches: usize = 0; var skipped: usize = 0; var skipped_names = "";
    for name in names limit Iterations(256) {
        let remaining = maximum - consumed;
        let per_file = if maximum == 4194304 { 65536 } else { if maximum == 4096 { 2048 } else { 16384 } };
        let bound = if remaining < per_file { remaining } else { per_file };
        let file = read_bounded(name, bound);
        if file.status != "complete" {
            if maximum != 4194304 { return outcome(file.status, name + ": " + file.text, scanned); }
            consumed = consumed + bound + 1;
            skipped = skipped + 1;
            if len(skipped_names) + len(name) < 1024 { skipped_names = skipped_names + name + "\n"; }
        } else {
        consumed = consumed + file.scanned;
        let lines = split(file.text, "\n");
        let line_limit = if maximum == 4096 { 128 } else { 16385 };
        if count(lines) > line_limit { return outcome("refused", "file exceeds line limit", scanned); }
        scanned = scanned + file.scanned;
        var line: usize = 0;
        for text in lines limit Iterations(16385) {
            line = line + 1;
            if contains(text, literal) {
                let entry = name + ":" + to_string_usize(line) + "\n";
                if matches >= 8 || len(output) + len(entry) > 1024 { return outcome(if maximum == 4194304 { "incomplete" } else { "truncated" }, if maximum == 4194304 { "match limit reached; partial results\n" + output } else { output }, scanned); }
                output = output + entry;
                matches = matches + 1;
            }
        }
        }
        if maximum == 4194304 && consumed >= maximum && name != names[count(names) - 1] { consumed = maximum + 1; break; }
    }
    if skipped > 0 || consumed > maximum { return outcome("incomplete", (if consumed > maximum { "scan allowance exhausted; " } else { "" }) + "skipped " + to_string_usize(skipped) + " unsupported or oversized files; partial results; skipped names (may be partial):\n" + skipped_names + "matches:\n" + output, scanned); }
    return outcome("complete", output, scanned);
}

public flow search_files(names: Array<string>, literal: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoSearch<ReadOnlyRoot> {
    if count(names) > 0 && names[0] == "*" {
        if count(names) > 257 { return outcome("refused", "search file count exceeds scope", 0); }
        var selected: Array<string> = []; var i: usize = 1;
        while i < count(names) limit Iterations(256) { selected = selected.push(names[i]); i = i + 1; }
        return search_with(selected, literal, 4194304);
    }
    return search_with(names, literal, 16384);
}
public flow search_legacy(names: Array<string>, literal: string) -> Outcome ![Fs.read<ReadOnlyRoot>, Error<FileError>, Error<IndexError>] ~ NomoSearch<ReadOnlyRoot> {
    return search_with(names, literal, 4096);
}
