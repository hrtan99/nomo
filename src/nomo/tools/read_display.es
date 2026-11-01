module nomo.tools.read_display;

import std.text.{len, split};
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import nomo.core.read_text.safe;
import nomo.tools.read_contract.{Outcome, outcome};

// Display selected UTF-8 file data as a safe single terminal line. Escape
// marker prefixes before using markers for the three admitted line controls.
public flow display(result: Outcome) -> Outcome {
    if len(result.text) > 1024 || byte_count(utf8_encode(result.text)) > 1024 {
        return outcome("refused", "result exceeds 1024 UTF-8 bytes", result.scanned);
    }
    var escaped = "";
    for character in split(result.text, "") limit Iterations(1026) {
        if character == "\n" { escaped = escaped + "<LF>"; }
        else if character == "\r" { escaped = escaped + "<CR>"; }
        else if character == "\t" { escaped = escaped + "<TAB>"; }
        else if character == "<" { escaped = escaped + "<LT>"; }
        else {
            if character != "" && !safe(character, 4) {
                return outcome("unsupported", "result contains unsupported terminal characters", result.scanned);
            }
            escaped = escaped + character;
        }
    }
    if byte_count(utf8_encode(escaped)) > 1024 {
        return outcome("refused", "escaped result exceeds 1024 UTF-8 bytes", result.scanned);
    }
    return outcome(result.status, escaped, result.scanned);
}
