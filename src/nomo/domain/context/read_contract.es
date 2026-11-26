module nomo.domain.context.read_contract;

import nomo.domain.context.large_context.{file_bytes, outcome_bytes};
import std.fs.{Region, IOError as FileError};
import std.effects.Fs;
import std.runtime.error.IndexError;
import std.text.{char_count as len, replace};
import nomo.domain.text.text.printable;

public type Outcome = { status: string, text: string, scanned: usize };

public flow outcome(status: string, text: string, scanned: usize) -> Outcome {
    return Outcome { status, text, scanned };
}

public spec NomoRead<R ~ Region>: callable string => Outcome ![Fs.read<R>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>];

public spec NomoSearch<R ~ Region>: callable (Array<string>, string) => Outcome ![Fs.read<R>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>];

// Terminal/history text stays one line. Marker encoding escapes '<' as <LT>,
// so a literal marker cannot impersonate LF/CR/TAB. Other controls are refused.
public flow display(result: Outcome) -> Outcome {
    if len(result.text) > file_bytes() { return outcome("refused", "result exceeds 1048576 characters", result.scanned); }
    var checked = replace(result.text, "\n", "");
    checked = replace(checked, "\r", "");
    checked = replace(checked, "\t", "");
    if !printable(checked) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
    var escaped = replace(result.text, "<", "<LT>");
    escaped = replace(escaped, "\n", "<LF>");
    escaped = replace(escaped, "\r", "<CR>");
    escaped = replace(escaped, "\t", "<TAB>");
    if len(escaped) > outcome_bytes() { return outcome("refused", "escaped result exceeds 1048576 characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}
