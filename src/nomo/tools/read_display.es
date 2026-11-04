module nomo.tools.read_display;

import std.text.{len, split, join};
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import nomo.core.read_text.safe;
import nomo.tools.read_contract.{Outcome, outcome};

// Display selected UTF-8 file data as a safe single terminal line. Escape
// marker prefixes before using markers for the three admitted line controls.
public flow display(result: Outcome) -> Outcome {
    if len(result.text) > 65536 || byte_count(utf8_encode(result.text)) > 65536 {
        return outcome("refused", "result exceeds 65536 UTF-8 bytes", result.scanned);
    }
    var escaped = join(split(result.text, "<"), "<LT>");
    escaped = join(split(escaped, "\n"), "<LF>");
    escaped = join(split(escaped, "\r"), "<CR>");
    escaped = join(split(escaped, "\t"), "<TAB>");
    if byte_count(utf8_encode(escaped)) > 262144 {
        return outcome("refused", "escaped result exceeds 262144 UTF-8 bytes", result.scanned);
    }
    if !safe(escaped, 262144) { return outcome("unsupported", "result contains unsupported terminal characters", result.scanned); }
    return outcome(result.status, escaped, result.scanned);
}
