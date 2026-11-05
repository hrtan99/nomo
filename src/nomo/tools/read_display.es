module nomo.tools.read_display;

import std.text.{len, replace};
import nomo.core.read_text.safe;
import nomo.tools.read_contract.{Outcome, outcome};
import nomo.core.large_context.{file_bytes, display_bytes};

// Display selected UTF-8 file data as a safe single terminal line. Percent is
// doubled before %n/%r/%t encode the three admitted line controls. This
// reversible form expands by at most 2x and stays below Host value limits.
public flow display(result: Outcome) -> Outcome {
    if len(result.text) > file_bytes() {
        return outcome("refused", "result exceeds 262144 UTF-8 bytes", result.scanned);
    }
    var escaped = replace(result.text, "%", "%%");
    escaped = replace(escaped, "\n", "%n");
    escaped = replace(escaped, "\r", "%r");
    escaped = replace(escaped, "\t", "%t");
    if len(escaped) > display_bytes() {
        return outcome("refused", "escaped result exceeds 524288 UTF-8 bytes", result.scanned);
    }
    if !safe(escaped, display_bytes()) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}
