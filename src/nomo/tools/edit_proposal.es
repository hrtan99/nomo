module nomo.tools.edit_proposal;

import std.text.{TextError, len, find, find_from, char_get, from_char, from_usize, replace_range};
import std.codec.text.utf8_encode;
import nomo.tools.path_policy.valid_path;
import nomo.core.large_context.file_bytes;

public type Request = { path: string, original: string, target: string, replacement: string };
public type Proposal = { path: string, before: string, after: string };

// Align with the large-context read contract, not scalar/grapheme count.
// Provided strings already exist; this is not a general allocation guarantee.
public flow text_bytes(value: string, field: string) -> Result<usize, string> {
    let size = len(value); if size > file_bytes() { return Err(field + " exceeds " + from_usize(file_bytes()) + " UTF-8 bytes"); }
    let bytes = utf8_encode(value);
    let zero: u8 = 0; var index: usize = 0;
    while index < size limit Iterations(1048576) {
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
    if target_bytes == 0 { if original_bytes == 0 && replacement_bytes > 0 { return Ok(Proposal { path = request.path, before = request.original, after = request.replacement }); } return Err("target must not be empty"); }

    // Search again after the first matched scalar to detect every later match,
    // including overlapping ones, before applying the exact byte range.
    let first_index = match find(request.original, request.target) { Some(value) => value, None() => { return Err("literal target not found"); } };
    let first = match char_get(request.target, 0) { Some(value) => from_char(value), None() => { return Err("literal match framing invalid"); } };
    let later: Result<Option<usize>, TextError> = find_from(request.original, request.target, first_index + len(first))?;
    match later { Ok(Some(_)) => { return Err("literal target is ambiguous"); }, Ok(None()) => {} Err(_) => { return Err("literal match framing invalid"); } }
    if request.target == request.replacement { return Err("replacement leaves original unchanged"); }
    // The exact match proves target_bytes <= original_bytes. Reject expansion
    // before constructing any output, then replace the proven byte interval.
    if original_bytes - target_bytes + replacement_bytes > file_bytes() { return Err("result exceeds " + from_usize(file_bytes()) + " UTF-8 bytes"); }
    let changed: Result<string, TextError> = replace_range(request.original, [first_index, first_index + target_bytes), request.replacement)?;
    let after = match changed { Ok(value) => value, Err(_) => { return Err("literal match framing invalid"); } };
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
