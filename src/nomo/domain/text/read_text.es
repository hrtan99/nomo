module nomo.domain.text.read_text;

import std.text.{len, trim, chars};
import nomo.domain.context.large_context.event_bytes;

// Read-only conversational text: UTF-8 byte ceilings remain explicit.
// Reject C0/C1 controls, terminal escape, Unicode line separators and common
// invisible bidirectional formatting controls before any terminal output.
public flow within(text: string, maximum: usize) -> bool {
    return len(text) <= maximum;
}

flow printable(character: char) -> bool {
    let code = character.to_u32();
    return !character.is_control() &&
        !(code >= 0x200b && code <= 0x200f) &&
        !(code >= 0x2028 && code <= 0x202e) &&
        !(code >= 0x2060 && code <= 0x2069) && code != 0xfeff;
}

public flow safe(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= event_bytes() && within(text, maximum) &&
        chars(text).all(character => printable(character));
}

public flow data_safe(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= event_bytes() && within(text, maximum) &&
        chars(text).all(character => character == '\n' || character == '\r' || character == '\t' || printable(character));
}

public flow bounded(text: string, maximum: usize) -> bool {
    return text != "" && trim(text) != "" && data_safe(text, maximum);
}

// Search is literal and bounded in UTF-8 bytes; spaces remain valid data.
public flow search_literal(value: string) -> bool {
    return value != "" && safe(value, 65536);
}
