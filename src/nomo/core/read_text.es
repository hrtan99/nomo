module nomo.core.read_text;

import std.text.{len, split, trim};
import std.codec.text.utf8_encode;
import std.bytes.len as bytes_len;

// Read-only conversational text: UTF-8 byte ceilings remain explicit.
// Reject C0/C1 controls, terminal escape, Unicode line separators and common
// invisible bidirectional formatting controls before any terminal output.
public flow safe(text: string, maximum: usize) -> bool {
    if maximum == 0 || maximum > 262144 || len(text) > maximum { return false; }
    if bytes_len(utf8_encode(text)) > maximum { return false; }
    for character in split(text, "") limit Iterations(262146) {
        if character != "" {
            let bytes = utf8_encode(character); let size = bytes_len(bytes);
            if size == 1 && (bytes[0] < 32 || bytes[0] == 127) { return false; }
            if size == 2 && bytes[0] == 194 && bytes[1] >= 128 && bytes[1] <= 159 { return false; }
            if size == 3 && bytes[0] == 226 && bytes[1] == 128 &&
                ((bytes[2] >= 139 && bytes[2] <= 143) || (bytes[2] >= 168 && bytes[2] <= 174)) { return false; }
            if size == 3 && bytes[0] == 226 && bytes[1] == 129 && bytes[2] >= 160 && bytes[2] <= 169 { return false; }
            if size == 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191 { return false; }
        }
    }
    return true;
}

public flow bounded(text: string, maximum: usize) -> bool {
    return text != "" && trim(text) != "" && safe(text, maximum);
}
