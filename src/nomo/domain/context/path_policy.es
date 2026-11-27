module nomo.domain.context.path_policy;

import std.text.{split, contains, starts_with, ends_with, is_ascii};
import nomo.domain.text.read_text.safe;

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
