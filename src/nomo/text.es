module nomo.text;

import std.text.{split, contains, len, trim, starts_with};

public flow printable(text: string) -> bool {
    let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    for character in split(text, "") limit Iterations(1026) {
        if character != "" && !contains(allowed, character) { return false; }
    }
    return true;
}

public flow input_error(raw: string) -> string {
    if len(raw) > 1024 { return "input exceeds 1024 characters"; }
    let request = trim(raw);
    if request == "" { return "empty input"; }
    if !printable(request) { return "expected printable ASCII single-line input"; }
    if starts_with(request, "/") { return "unsupported command; use /help or /exit in line mode"; }
    return "";
}
