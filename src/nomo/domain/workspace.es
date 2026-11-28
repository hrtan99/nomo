module nomo.domain.workspace;

import nomo.domain.limits.{display_bytes, file_bytes, outcome_bytes};
import nomo.domain.text.{safe, text_printable};
import std.text.{
    char_count,
    contains,
    ends_with,
    from_usize,
    is_ascii,
    len,
    parse_usize,
    replace,
    rsplit_once,
    split,
    starts_with,
    strip_prefix
};

public type ProjectInstruction = { scope: string, path: string, text: string };

public flow guide_path(scope: string) -> string {
    return if scope == "." { "AGENTS.md" } else { scope + "/AGENTS.md" };
}

// Candidate ancestor scopes only. The reader still observes existence in order.
public flow child_scopes(normalized: string) -> Array<string> {
    let parent = match rsplit_once(normalized, "/") { Some((value, _)) => value, None() => "." };
    var result: Array<string> = [];
    var scope = ".";
    for component in split(parent, "/") {
        if component == "." || component == "" { continue; }
        scope = if scope == "." { component } else { scope + "/" + component };
        result = result.push(scope);
    }
    return result;
}

// Canonical relative-name policy only; Host region enforcement is separate.
public flow valid_path(name: string) -> bool {
    if name == "" || !safe(name, 128) || starts_with(name, "/") { return false; }
    let parts = split(name, "/");
    if parts.len() > 8 { return false; }
    return parts.iter().all(part => part != "" && part != "." && part != ".." &&
        !starts_with(part, " ") && !ends_with(part, " ") &&
        std.text.chars(part).all(codepoint => {
            let character = std.text.from_char(codepoint);
            return !is_ascii(character) || contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._- @+()[]", character);
        }));
}

public type Outcome = { status: string, text: string, scanned: usize };

public flow outcome(status: string, text: string, scanned: usize) -> Outcome {
    return Outcome { status, text, scanned };
}

// Terminal/history text stays one line. Marker encoding escapes '<' as <LT>,
// so a literal marker cannot impersonate LF/CR/TAB. Other controls are refused.
public flow read_contract_display(result: Outcome) -> Outcome {
    if char_count(result.text) > file_bytes() { return outcome("refused", "result exceeds 1048576 characters", result.scanned); }
    var checked = replace(result.text, "\n", "");
    checked = replace(checked, "\r", "");
    checked = replace(checked, "\t", "");
    if !text_printable(checked) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
    var escaped = replace(result.text, "<", "<LT>");
    escaped = replace(escaped, "\n", "<LF>");
    escaped = replace(escaped, "\r", "<CR>");
    escaped = replace(escaped, "\t", "<TAB>");
    if char_count(escaped) > outcome_bytes() { return outcome("refused", "escaped result exceeds 1048576 characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}

// Display selected UTF-8 file data as a safe single terminal line. Percent is
// doubled before %n/%r/%t encode the three admitted line controls. This
// reversible form expands by at most 2x and stays below Host value limits.
public flow read_display_display(result: Outcome) -> Outcome {
    if len(result.text) > file_bytes() {
        return outcome("refused", "result exceeds " + from_usize(file_bytes()) + " UTF-8 bytes", result.scanned);
    }
    var escaped = replace(result.text, "%", "%%");
    escaped = replace(escaped, "\n", "%n");
    escaped = replace(escaped, "\r", "%r");
    escaped = replace(escaped, "\t", "%t");
    if len(escaped) > display_bytes() {
        return outcome("refused", "escaped result exceeds " + from_usize(display_bytes()) + " UTF-8 bytes", result.scanned);
    }
    if !safe(escaped, display_bytes()) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}

// Discovery is bounded and rooted in the currently selected read-only region.
public type DiscoveredFileInfo = { is_file: bool, is_dir: bool, len: u64 };

public type Discovery = { files: Array<string>, page: usize, more: bool };

public enum ProjectReference { Saved(usize), Folder(string) }

public type LaunchRequest = { workspace: string, arguments: Array<string> };

public flow remembered(workspace: string, recent: Array<string>) -> Array<string> {
    return [workspace].extend(recent.retain(value => value != workspace));
}

public flow reference(selection: string, workspace: string) -> ProjectReference {
    return match parse_usize(selection) {
        Ok(index) => ProjectReference.Saved(index),
        Err(_) => ProjectReference.Folder(match strip_prefix(selection, "/") {
            Some(_) => selection,
            None() => match strip_prefix(selection, "~/") { Some(_) => selection, None() => workspace + "/" + selection },
        })
    };
}

public flow saved(folders: Array<string>, index: usize) -> string ![Error<IndexError>] {
    if index == 0 || index > folders.len() { abort("project number is outside the saved list"); }
    return folders[index - 1];
}

public type FileContent = { path: string, text: string, instructions: Array<ProjectInstruction> };

public type PathInfo = { path: string, is_file: bool, is_dir: bool, bytes: u64 };

public type MatchLine = { path: string, line: usize, text: string };

public type SearchRequest = { paths: Array<string>, literal: string };
