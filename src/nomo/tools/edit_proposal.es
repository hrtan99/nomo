module nomo.tools.edit_proposal;

import std.text.{len, split};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.tools.path_policy.valid_path;

public type Request = { path: string, original: string, target: string, replacement: string };
public type Proposal = { path: string, before: string, after: string };

// Align with the read contract's 2048 UTF-8 bytes, not scalar/grapheme count.
// Provided strings already exist; this is not a general allocation guarantee.
public flow text_bytes(value: string, field: string) -> Result<usize, string> {
    if len(value) > 2048 { return Err(field + " exceeds 2048 UTF-8 bytes"); }
    let bytes = utf8_encode(value); let size = byte_count(bytes);
    if size > 2048 { return Err(field + " exceeds 2048 UTF-8 bytes"); }
    let zero: u8 = 0; var index: usize = 0;
    while index < size limit Iterations(2048) {
        if bytes[index] == zero { return Err(field + " contains NUL"); }
        index = index + 1;
    }
    return Ok(size);
}

// NUL-free UTF-8 text is data, including Unicode and original line endings.
// The path is canonical syntax only; no filesystem authority is established.
public flow propose(request: Request) -> Result<Proposal, string> {
    if !valid_path(request.path) { return Err("invalid relative path"); }
    let original_bytes = match text_bytes(request.original, "original") { Ok(value) => value, Err(error) => { return Err(error); } };
    let target_bytes = match text_bytes(request.target, "target") { Ok(value) => value, Err(error) => { return Err(error); } };
    let replacement_bytes = match text_bytes(request.replacement, "replacement") { Ok(value) => value, Err(error) => { return Err(error); } };
    if target_bytes == 0 { return Err("target must not be empty"); }

    // Both arrays have one leading and one trailing empty split sentinel.
    // Check every scalar start, advancing one even after a matching candidate.
    let characters = split(request.original, "");
    let target = split(request.target, "");
    if count(characters) < 2 || count(target) < 3 { return Err("literal match framing invalid"); }
    let size = count(characters) - 2; let target_size = count(target) - 2;
    var start: usize = 0; var position: usize = 0; var matches: usize = 0;
    while start < size limit Iterations(2048) {
        if target_size <= size - start {
            var equal = true; var offset: usize = 0;
            while offset < target_size && equal limit Iterations(2048) {
                if characters[start + offset + 1] != target[offset + 1] { equal = false; }
                offset = offset + 1;
            }
            if equal {
                matches = matches + 1; position = start;
                if matches > 1 { return Err("literal target is ambiguous"); }
            }
        }
        start = start + 1;
    }
    if matches == 0 { return Err("literal target not found"); }
    if request.target == request.replacement { return Err("replacement leaves original unchanged"); }
    // The exact match proves target_bytes <= original_bytes. Reject expansion
    // before constructing any output, then preserve untouched text in one pass.
    if original_bytes - target_bytes + replacement_bytes > 2048 { return Err("result exceeds 2048 UTF-8 bytes"); }
    var after = ""; var index: usize = 0;
    while index < size limit Iterations(2048) {
        if index == position { after = after + request.replacement; index = index + target_size; }
        else { after = after + characters[index + 1]; index = index + 1; }
    }
    return Ok(Proposal { path = request.path, before = request.original, after = after });
}

// Recompute from the bound request; a bare before/after value is not approval,
// persistence, a current-file check or a compare-and-swap guarantee.
public flow validate(request: Request, proposal: Proposal) -> Result<Proposal, string> {
    let expected = match propose(request) { Ok(value) => value, Err(error) => { return Err(error); } };
    if proposal.path != expected.path || proposal.before != expected.before || proposal.after != expected.after {
        return Err("proposal differs from validated replacement");
    }
    return Ok(expected);
}
