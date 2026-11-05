module nomo.ui.edit_diff;

import std.text.{char_count as len, split, strip_prefix, strip_suffix, from_usize};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.tools.edit_proposal.text_bytes;
import nomo.tools.edit_encoding.json;

type Line = { text: string, terminated: bool };

// Keep the final LF as data. An empty file has no line; a CR remains visible
// through the established ASCII encoder, preserving the distinction from LF.
flow lines(value: string) -> Array<Line> {
    let parts = split(value, "\n");
    var output: Array<Line> = []; var index: usize = 0;
    while index < count(parts) limit Iterations(65537) {
        if index + 1 < count(parts) {
            output = output.push(Line { text = parts[index], terminated = true });
        } else if parts[index] != "" {
            output = output.push(Line { text = parts[index], terminated = false });
        }
        index = index + 1;
    }
    return output;
}

flow same(left: Line, right: Line) -> bool {
    return left.text == right.text && left.terminated == right.terminated;
}

// Measure each entire encoded scalar before selecting it. In particular an
// emoji's two JSON surrogate escapes are kept together. Never slice an escape.
flow line_text(raw: string) -> Result<string, string> {
    var selected = ""; var width: usize = 0; var clipped = false;
    for codepoint in std.text.chars(raw) limit Iterations(65538) { let character = std.text.from_char(codepoint);
        if character != "" {
            let encoded = match json([character]) { Ok(value) => value, Err(error) => { return Err(error); } };
            let size = len(encoded) - 4;
            if width + size > 160 { clipped = true; break; }
            selected = selected + character; width = width + size;
        }
    }
    let encoded = match json([selected]) { Ok(value) => value, Err(error) => { return Err(error); } };
    // Remove only the known ["..."] framing, after encoding complete scalars.
    let framed = match strip_prefix(encoded, "[\"") { Some(value) => value, None() => { return Err("edit preview JSON framing invalid"); } };
    var output = match strip_suffix(framed, "\"]") { Some(value) => value, None() => { return Err("edit preview JSON framing invalid"); } };
    if clipped { output = output + " ... [line truncated]"; }
    return Ok(output);
}

flow heading(label: string, values: Array<Line>) -> string {
    if count(values) == 0 { return label + " [empty file]\n"; }
    if !values[count(values) - 1].terminated { return label + " [no final newline]\n"; }
    return label + "\n";
}

flow shown(mark: string, value: Line) -> Result<string, string> {
    return match line_text(value.text) { Ok(text) => Ok(mark + text + "\n"), Err(error) => Err(error) };
}

flow omitted(size: usize, kind: string) -> string {
    return "... " + from_usize(size) + " " + kind + " lines omitted ...\n";
}

flow context(values: Array<Line>, start: usize, end: usize) -> Result<string, string> {
    var output = ""; var index = start;
    while index < end limit Iterations(2) {
        let text = match shown("  ", values[index]) { Ok(value) => value, Err(error) => { return Err(error); } };
        output = output + text; index = index + 1;
    }
    return Ok(output);
}

flow changed(values: Array<Line>, start: usize, end: usize, mark: string, kind: string) -> Result<string, string> {
    var output = ""; var index = start; var selected: usize = 0;
    while index < end && selected < 12 limit Iterations(12) {
        let text = match shown(mark, values[index]) { Ok(value) => value, Err(error) => { return Err(error); } };
        output = output + text; index = index + 1; selected = selected + 1;
    }
    if index < end { output = output + omitted(end - index, kind); }
    return Ok(output);
}

// Presentation only, not an applicable patch or edit authority. Compare exact
// common prefix/suffix lines; interior unchanged lines may appear in both blocks.
// Two context lines per edge, twelve changed lines per side and 160 encoded
// columns per line bound the display independently of the canonical PREVIEW.
public flow render(before: string, after: string) -> Result<string, string> {
    match text_bytes(before, "preview before") { Ok(_) => {} Err(error) => { return Err(error); } }
    match text_bytes(after, "preview after") { Ok(_) => {} Err(error) => { return Err(error); } }
    if before == after { return Err("edit preview requires a change"); }
    let original = lines(before); let replacement = lines(after);
    let old_size = count(original); let new_size = count(replacement);
    var prefix: usize = 0;
    while prefix < old_size && prefix < new_size limit Iterations(65536) {
        if !same(original[prefix], replacement[prefix]) { break; }
        prefix = prefix + 1;
    }
    var suffix: usize = 0;
    while suffix < old_size - prefix && suffix < new_size - prefix limit Iterations(65536) {
        if !same(original[old_size - suffix - 1], replacement[new_size - suffix - 1]) { break; }
        suffix = suffix + 1;
    }
    var output = heading("--- before", original) + heading("+++ after", replacement);
    let first = if prefix > 2 { prefix - 2 } else { 0 };
    if first > 0 { output = output + omitted(first, "unchanged"); }
    let leading = match context(original, first, prefix) { Ok(value) => value, Err(error) => { return Err(error); } };
    output = output + leading;
    let removed = match changed(original, prefix, old_size - suffix, "- ", "removed") { Ok(value) => value, Err(error) => { return Err(error); } };
    let added = match changed(replacement, prefix, new_size - suffix, "+ ", "added") { Ok(value) => value, Err(error) => { return Err(error); } };
    output = output + removed + added;
    let visible = if suffix > 2 { 2 } else { suffix };
    let trailing = match context(replacement, new_size - suffix, new_size - suffix + visible) { Ok(value) => value, Err(error) => { return Err(error); } };
    output = output + trailing;
    if suffix > visible { output = output + omitted(suffix - visible, "unchanged"); }
    if len(output) > 8192 || byte_count(utf8_encode(output)) > 8192 { return Err("edit preview output exceeds 8192 bytes"); }
    return Ok(output);
}
