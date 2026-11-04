module nomo.core.read_text;

import std.text.{len, trim, contains};
import std.json.parse;
import std.agent.message.Message;
import std.codec.text.utf8_encode;
import std.bytes.len as bytes_len;

// Read-only conversational text: UTF-8 byte ceilings remain explicit.
// Reject C0/C1 controls, terminal escape, Unicode line separators and common
// invisible bidirectional formatting controls before any terminal output.
public flow within(text: string, maximum: usize) -> bool {
    return len(text) <= maximum && bytes_len(utf8_encode(text)) <= maximum;
}

public flow safe(text: string, maximum: usize) -> bool {
    if maximum == 0 || maximum > 524288 || !within(text, maximum) { return false; }
    let bytes = utf8_encode(text); let size = bytes_len(bytes); var index: usize = 0;
    if size <= 256 {
        while index < size limit Iterations(256) {
            let first = bytes[index];
            if first < 32 || first == 127 || (first == 194 && index + 1 < size && bytes[index + 1] >= 128 && bytes[index + 1] <= 159) { return false; }
            if first == 226 && index + 2 < size && bytes[index + 1] == 128 && ((bytes[index + 2] >= 139 && bytes[index + 2] <= 143) || (bytes[index + 2] >= 168 && bytes[index + 2] <= 174)) { return false; }
            if first == 226 && index + 2 < size && bytes[index + 1] == 129 && bytes[index + 2] >= 160 && bytes[index + 2] <= 169 { return false; }
            if first == 239 && index + 2 < size && bytes[index + 1] == 187 && bytes[index + 2] == 191 { return false; }
            index = index + 1;
        }
        return true;
    }
    let value = match parse("[\"\u0000\",\"\u0001\",\"\u0002\",\"\u0003\",\"\u0004\",\"\u0005\",\"\u0006\",\"\u0007\",\"\u0008\",\"\u0009\",\"\u000a\",\"\u000b\",\"\u000c\",\"\u000d\",\"\u000e\",\"\u000f\",\"\u0010\",\"\u0011\",\"\u0012\",\"\u0013\",\"\u0014\",\"\u0015\",\"\u0016\",\"\u0017\",\"\u0018\",\"\u0019\",\"\u001a\",\"\u001b\",\"\u001c\",\"\u001d\",\"\u001e\",\"\u001f\",\"\u007f\",\"\u0080\",\"\u0081\",\"\u0082\",\"\u0083\",\"\u0084\",\"\u0085\",\"\u0086\",\"\u0087\",\"\u0088\",\"\u0089\",\"\u008a\",\"\u008b\",\"\u008c\",\"\u008d\",\"\u008e\",\"\u008f\",\"\u0090\",\"\u0091\",\"\u0092\",\"\u0093\",\"\u0094\",\"\u0095\",\"\u0096\",\"\u0097\",\"\u0098\",\"\u0099\",\"\u009a\",\"\u009b\",\"\u009c\",\"\u009d\",\"\u009e\",\"\u009f\",\"\u200b\",\"\u200c\",\"\u200d\",\"\u200e\",\"\u200f\",\"\u2028\",\"\u2029\",\"\u202a\",\"\u202b\",\"\u202c\",\"\u202d\",\"\u202e\",\"\u2060\",\"\u2061\",\"\u2062\",\"\u2063\",\"\u2064\",\"\u2065\",\"\u2066\",\"\u2067\",\"\u2068\",\"\u2069\",\"\ufeff\"]") { Ok(item) => item, Err(_) => { return false; } };
    let decoded: Option<Message<Array<string>>> = Message.new(value).cast<Array<string>>();
    let controls = match decoded { Some(item) => item.body, None() => { return false; } };
    for character in controls limit Iterations(90) {
        if contains(text, character) { return false; }
    }
    return true;
}

public flow bounded(text: string, maximum: usize) -> bool {
    return text != "" && trim(text) != "" && safe(text, maximum);
}

// Search is literal and bounded in UTF-8 bytes; spaces remain valid data.
public flow search_literal(value: string) -> bool {
    return value != "" && safe(value, 64);
}
