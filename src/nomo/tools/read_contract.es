module nomo.tools.read_contract;

import std.fs.Region;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.runtime.error.IndexError;
import std.text.{char_count as len, replace};
import nomo.core.text.printable;

public type Outcome = { status: string, text: string, scanned: usize };

public flow outcome(status: string, text: string, scanned: usize) -> Outcome {
    return Outcome { status = status, text = text, scanned = scanned };
}

public spec NomoRead<R ~ Region>: callable string => Outcome ![Fs.read<R>, Error<FileError>, Error<IndexError>];
public spec NomoSearch<R ~ Region>: callable (Array<string>, string) => Outcome ![Fs.read<R>, Error<FileError>, Error<IndexError>];
public effect ReadTools {
    action read(name: string) -> Outcome;
    action search(names: Array<string>, literal: string) -> Outcome;
}

// Terminal/history text stays one line. Marker encoding escapes '<' as <LT>,
// so a literal marker cannot impersonate LF/CR/TAB. Other controls are refused.
public flow display(result: Outcome) -> Outcome {
    if len(result.text) > 1024 { return outcome("refused", "result exceeds 1024 characters", result.scanned); }
    var checked = replace(result.text, "\n", "");
    checked = replace(checked, "\r", "");
    checked = replace(checked, "\t", "");
    if !printable(checked) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
    var escaped = replace(result.text, "<", "<LT>");
    escaped = replace(escaped, "\n", "<LF>");
    escaped = replace(escaped, "\r", "<CR>");
    escaped = replace(escaped, "\t", "<TAB>");
    if len(escaped) > 1024 { return outcome("refused", "escaped result exceeds 1024 characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}
