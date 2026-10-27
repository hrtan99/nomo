module nomo.tools.path_policy;

import std.text.{len, split, contains, starts_with};
import std.collections.len as count;

// Canonical relative-name policy only; Host region enforcement is separate.
public flow valid_path(name: string) -> bool {
    if len(name) == 0 || len(name) > 128 || starts_with(name, "/") { return false; }
    let parts = split(name, "/");
    if count(parts) > 8 { return false; }
    for part in parts limit Iterations(8) {
        if part == "" || part == "." || part == ".." { return false; }
        for character in split(part, "") limit Iterations(130) {
            if character != "" && !contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", character) { return false; }
        }
    }
    return true;
}
