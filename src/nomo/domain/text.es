module nomo.domain.text;

import nomo.domain.limits.{context_bytes, event_bytes, message_bytes};
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import std.text.{char_count, chars, contains, from_char, is_ascii, len, starts_with, trim};

// Read-only conversational text: UTF-8 byte ceilings remain explicit.
// Reject C0/C1 controls, terminal escape, Unicode line separators and common
// invisible bidirectional formatting controls before any terminal output.
public flow within(text: string, maximum: usize) -> bool {
    return len(text) <= maximum;
}

flow read_text_printable(character: char) -> bool {
    let code = character.to_u32();
    return !character.is_control() && !(code >= 0x200b && code <= 0x200f) && !(
        code >= 0x2028
            && code <= 0x202e
    ) && !(code >= 0x2060 && code <= 0x2069) && code != 0xfeff;
}

public flow safe(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= event_bytes() && within(text, maximum)
        && chars(text).all(character => read_text_printable(character));
}

public flow data_safe(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= event_bytes() && within(text, maximum)
        && chars(text).all(
        character => character == '\n' || character == '\r' || character == '\t'
            || read_text_printable(character)
    );
}

public flow bounded(text: string, maximum: usize) -> bool {
    return text != "" && trim(text) != "" && data_safe(text, maximum);
}

// Search is literal and bounded in UTF-8 bytes; spaces remain valid data.
public flow search_literal(value: string) -> bool {
    return value != "" && safe(value, 65536);
}

public flow text_printable(text: string) -> bool {
    return is_ascii(text) && safe(text, event_bytes());
}

public flow input_error(raw: string) -> string {
    if char_count(raw) > message_bytes() {
        return "input exceeds 1048576 characters";
    }
    let request = trim(raw);
    if request == "" {
        return "empty input";
    }
    if !text_printable(request) {
        return "expected printable ASCII single-line input";
    }
    if starts_with(request, "/") {
        return "unsupported command; use /help or /exit in line mode";
    }
    return "";
}

// Reuse the checked JSON conversion while preserving each caller's limit and units.
public flow context_json_error(
    value: Option<Message<JsonValue>>,
    maximum: usize,
    bytes: bool,
    overflow: string
) -> string {
    let json = match value {
        Some(item) => item.body,
        None() => {
            return "context conversion refused";
        }
    };
    let encoded = match stringify(json) {
        Ok(item) => item,
        Err(_) => {
            return "context JSON refused";
        }
    };
    if (if bytes {
        len(encoded)
    } else {
        char_count(encoded)
    }) > maximum {
        return overflow;
    }
    return "";
}

// Bound a flat JSON string array before its caller invokes the JSON parser.
public flow flat_string_frame(raw: string, maximum: usize, exact: bool) -> bool {
    if char_count(raw) > context_bytes() || len(raw) > context_bytes() {
        return false;
    }
    var opened = false;
    var closed = false;
    var quoted = false;
    var escaped = false;
    var leaves: usize = 0;
    let slash = from_char('\\');
    @limits([Iterations(33554434)]) for codepoint in std.text.chars(raw) {
        let character = std.text.from_char(codepoint);
        if quoted {
            if escaped {
                escaped = false;
            }
            else if character == slash {
                escaped = true;
            }
            else if character == "\"" {
                quoted = false;
            }
        } else if character == "" || character == " " || character == "\t" || character == "\r"
            || character == "\n" {
        } else if character == "[" {
            if opened || closed {
                return false;
            }
            opened = true;
        } else if character == "]" {
            if !opened || closed {
                return false;
            }
            closed = true;
        } else if character == "\"" {
            if !opened || closed {
                return false;
            }
            leaves = leaves + 1;
            if leaves > maximum {
                return false;
            }
            quoted = true;
        } else if character != "," || !opened || closed {
            return false;
        }
    }
    return opened && closed && !quoted && (!exact || leaves == maximum);
}

public flow hex_digest(value: string) -> bool {
    return len(value) == 64
        && std.text.chars(value).all(
        character => character.is_ascii_digit() || (character.to_u32() >= 97 && character.to_u32() <= 102)
    );
}
