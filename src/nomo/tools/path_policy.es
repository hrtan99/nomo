module nomo.tools.path_policy;

import std.text.{split, contains, starts_with, ends_with};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.core.read_text.safe;
import std.collections.len as count;

// Canonical relative-name policy only; Host region enforcement is separate.
public flow valid_path(name: string) -> bool {
    if name == "" || !safe(name, 128) || starts_with(name, "/") { return false; }
    let parts = split(name, "/");
    if count(parts) > 8 { return false; }
    for part in parts limit Iterations(8) {
        if part == "" || part == "." || part == ".." || starts_with(part, " ") || ends_with(part, " ") { return false; }
        for character in split(part, "") limit Iterations(130) {
            if character != "" && byte_count(utf8_encode(character)) == 1 && !contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._- @+()[]", character) { return false; }
        }
    }
    return true;
}
