module nomo.domain.editing;

import nomo.domain.limits.{file_bytes, message_bytes};
import nomo.domain.text.{hex_digest, text_printable};
import nomo.domain.wire.{digest, json};
import nomo.domain.workspace.valid_path;
import nomo.session.edit_operation.{Binding, Record};
import std.text.{
    TextError,
    char_count,
    char_get,
    concat,
    contains,
    ends_with,
    find,
    find_from,
    from_char,
    from_usize,
    len,
    replace_range,
    split,
    strip_prefix,
    strip_suffix,
    trim
};

let REGION = "nomo.tools.edit_file.EditableRoot";

public flow bind(id: string, workspace: string, path: string, value: Prepared) -> Result<Binding, string> {
    let invalid_selector = selector_error(id, workspace, path);
    if invalid_selector != "" {
        return Err(invalid_selector);
    }
    if path != value.request.path || path != value.proposal.path {
        return Err("edit selector differs from prepared request");
    }
    match validate(value.request, value.proposal) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let proposal = value.proposal;
    let canonical = match json(
        [
            "nomo-edit-request-v1",
            id,
            workspace,
            REGION,
            proposal.path,
            proposal.before,
            value.request.target,
            value.request.replacement,
            proposal.after
        ]
    ) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let before = match digest(proposal.before) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let after = match digest(proposal.after) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let request = match digest(canonical) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let result = Binding {
        id,
        workspace,
        region = REGION,
        path = proposal.path,
        request_digest = request,
        before_digest = before,
        after_digest = after,
        before_bytes = len(proposal.before),
        after_bytes = len(proposal.after)
    };
    let invalid = binding_error(result);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(result);
}

public type Prepared = {
    request: Request,
    proposal: Proposal
};

public type Selector = {
    id: string,
    workspace: string,
    path: string
};

public type Confirmed = {
    binding: Binding,
    after: string
};

// Reuse the complete supported original already supplied to an edit child.
// File state is still checked by apply after the durable intent.
public flow prepare_original(name: string, original: string, target: string, replacement: string) -> Result<
    Prepared,
    string
> {
    let request = Request {
        path = name,
        original,
        target,
        replacement
    };
    let proposal = match propose(request) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(Prepared {
        request,
        proposal
    });
}

public flow prepare_original_legacy(name: string, original: string, target: string, replacement: string) -> Result<
    Prepared,
    string
> {
    if len(original) > file_bytes() || len(target) > file_bytes() || len(replacement) > file_bytes() {
        return Err("edit text exceeds 1048576 UTF-8 bytes");
    }
    let prepared = match prepare_original(name, original, target, replacement) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if len(prepared.proposal.after) > file_bytes() {
        return Err("edit result exceeds 1048576 UTF-8 bytes");
    }
    return Ok(prepared);
}

public type Contribution = {
    target: string,
    replacement: string
};

// The caller owns path/original; this value grants no File or approval authority.
// Reuse the complete literal, uniqueness, NUL/UTF-8 and changed-result guards.
public flow project(path: string, original: string, value: Contribution) -> Result<Proposal, string> {
    return propose(Request {
        path,
        original,
        target = value.target,
        replacement = value.replacement
    });
}

type Line = {
    text: string,
    terminated: bool
};

// Keep the final LF as data. An empty file has no line; a CR remains visible
// through the established ASCII encoder, preserving the distinction from LF.
flow lines(value: string) -> Array<Line> {
    let parts = split(value, "\n");
    return parts.iter().enumerate().filter_map(
        item => {
            let (index, text) = item;
            return if index + 1 < parts.len() || text != "" {
                Some(Line {
                    text,
                    terminated = index + 1 < parts.len()
                })
            } else {
                None()
            };
        }
    ).collect();
}

flow same(left: Line, right: Line) -> bool {
    return left.text == right.text && left.terminated == right.terminated;
}

// Measure each entire encoded scalar before selecting it. In particular an
// emoji's two JSON surrogate escapes are kept together. Never slice an escape.
flow line_text(raw: string) -> Result<string, string> {
    var selected = "";
    var width: usize = 0;
    var clipped = false;
    @limits([Iterations(65538)]) for codepoint in std.text.chars(raw) {
        let character = std.text.from_char(codepoint);
        if character != "" {
            let encoded = match json([character]) {
                Ok(value) => value,
                Err(error) => {
                    return Err(error);
                }
            };
            let size = char_count(encoded) - 4;
            if width + size > 160 {
                clipped = true;
                break;
            }
            selected = selected + character;
            width = width + size;
        }
    }
    let encoded = match json([selected]) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    // Remove only the known ["..."] framing, after encoding complete scalars.
    let framed = match strip_prefix(encoded, "[\"") {
        Some(value) => value,
        None() => {
            return Err("edit preview JSON framing invalid");
        }
    };
    var output = match strip_suffix(framed, "\"]") {
        Some(value) => value,
        None() => {
            return Err("edit preview JSON framing invalid");
        }
    };
    if clipped {
        output = output + " ... [line truncated]";
    }
    return Ok(output);
}

flow heading(label: string, values: Array<Line>) -> string {
    if values.len() == 0 {
        return label + " [empty file]\n";
    }
    if !values[values.len() - 1].terminated {
        return label + " [no final newline]\n";
    }
    return label + "\n";
}

flow shown(mark: string, value: Line) -> Result<string, string> {
    return match line_text(value.text) {
        Ok(text) => Ok(mark + text + "\n"),
        Err(error) => Err(error)
    };
}

flow omitted(size: usize, kind: string) -> string {
    return "... " + from_usize(size) + " " + kind + " lines omitted ...\n";
}

flow context(values: Array<Line>, start: usize, end: usize) -> Result<string, string> {
    var output: Array<string> = [];
    var index = start;
    @limits([Iterations(2)]) while index < end {
        let text = match shown("  ", values[index]) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        output = output.push(text);
        index = index + 1;
    }
    return Ok(concat(output));
}

flow changed(values: Array<Line>, start: usize, end: usize, mark: string, kind: string) -> Result<
    string,
    string
> {
    var output: Array<string> = [];
    var index = start;
    var selected: usize = 0;
    @limits([Iterations(12)]) while index < end && selected < 12 {
        let text = match shown(mark, values[index]) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        output = output.push(text);
        index = index + 1;
        selected = selected + 1;
    }
    if index < end {
        output = output.push(omitted(end - index, kind));
    }
    return Ok(concat(output));
}

// Presentation only, not an applicable patch or edit authority. Compare exact
// common prefix/suffix lines; interior unchanged lines may appear in both blocks.
// Two context lines per edge, twelve changed lines per side and 160 encoded
// columns per line bound the display independently of the canonical PREVIEW.
public flow render(before: string, after: string) -> Result<string, string> {
    match text_bytes(before, "preview before") {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    match text_bytes(after, "preview after") {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    if before == after {
        return Err("edit preview requires a change");
    }
    let original = lines(before);
    let replacement = lines(after);
    let old_size = original.len();
    let new_size = replacement.len();
    var prefix: usize = 0;
    @limits([Iterations(1048576)]) while prefix < old_size && prefix < new_size {
        if !same(original[prefix], replacement[prefix]) {
            break;
        }
        prefix = prefix + 1;
    }
    var suffix: usize = 0;
    @limits([Iterations(1048576)]) while suffix < old_size - prefix && suffix < new_size - prefix {
        if !same(original[old_size - suffix - 1], replacement[new_size - suffix - 1]) {
            break;
        }
        suffix = suffix + 1;
    }
    var output = [heading("--- before", original), heading("+++ after", replacement)];
    let first = if prefix > 2 {
        prefix - 2
    } else {
        0
    };
    if first > 0 {
        output = output.push(omitted(first, "unchanged"));
    }
    let leading = match context(original, first, prefix) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    output = output.push(leading);
    let removed = match changed(original, prefix, old_size - suffix, "- ", "removed") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let added = match changed(replacement, prefix, new_size - suffix, "+ ", "added") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    output = output.push(removed).push(added);
    let visible = if suffix > 2 {
        2
    } else {
        suffix
    };
    let trailing = match context(replacement, new_size - suffix, new_size - suffix + visible) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    output = output.push(trailing);
    if suffix > visible {
        output = output.push(omitted(suffix - visible, "unchanged"));
    }
    let rendered = concat(output);
    if char_count(rendered) > message_bytes() || len(rendered) > message_bytes() {
        return Err("edit preview output exceeds 1048576 bytes");
    }
    return Ok(rendered);
}

// A validated edit already supplies its unique literal target.  For large
// files, render that exact changed span directly instead of materializing and
// comparing hundreds of thousands of unchanged lines in the interpreter.
// The complete before/after values remain in the canonical PREVIEW record.
public flow render_edit(before: string, target: string, replacement: string, after: string) -> Result<
    string,
    string
> {
    if len(before) <= 262144 && len(after) <= 262144 {
        return render(before, after);
    }
    match text_bytes(before, "preview before") {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    match text_bytes(after, "preview after") {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    if before == after || target == "" {
        return Err("large edit preview requires a changed literal");
    }
    let start = match find(before, target) {
        Some(value) => value,
        None() => {
            return Err("large edit preview target missing");
        }
    };
    let tail = len(before) - start - len(target);
    var output = [
        if before == "" {
            "--- before [empty file]\n"
        } else {
            if ends_with(before, "\n") {
                "--- before\n"
            } else {
                "--- before [no final newline]\n"
            }
        },
        if after == "" {
            "+++ after [empty file]\n"
        } else {
            if ends_with(after, "\n") {
                "+++ after\n"
            } else {
                "+++ after [no final newline]\n"
            }
        }
    ];
    if start > 0 {
        output = output.push("... " + from_usize(start) + " unchanged prefix bytes omitted ...\n");
    }
    let removed = lines(target);
    let added = lines(replacement);
    let old = match changed(removed, 0, removed.len(), "- ", "removed") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let new = match changed(added, 0, added.len(), "+ ", "added") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    output = output.push(old).push(new);
    if tail > 0 {
        output = output.push("... " + from_usize(tail) + " unchanged suffix bytes omitted ...\n");
    }
    let rendered = concat(output);
    if len(rendered) > message_bytes() {
        return Err("edit preview output exceeds 1048576 bytes");
    }
    return Ok(rendered);
}

public type Request = {
    path: string,
    original: string,
    target: string,
    replacement: string
};

public type Proposal = {
    path: string,
    before: string,
    after: string
};

// Align with the large-context read contract, not scalar/grapheme count.
// Provided strings already exist; this is not a general allocation guarantee.
public flow text_bytes(value: string, field: string) -> Result<usize, string> {
    let size = len(value);
    if size > file_bytes() {
        return Err(field + " exceeds " + from_usize(file_bytes()) + " UTF-8 bytes");
    }
    if contains(value, "\u0000") {
        return Err(field + " contains NUL");
    }
    return Ok(size);
}

// NUL-free UTF-8 text is data, including Unicode and original line endings.
// The path is canonical syntax only; no filesystem authority is established.
public flow propose(request: Request) -> Result<Proposal, string> {
if !valid_path(request.path) {
    return Err("invalid relative path");
}
let original_bytes = match text_bytes(request.original, "original") {
    Ok(value) => value,
    Err(error) => {
        return Err(error);
    }
};
let target_bytes = match text_bytes(request.target, "target") {
    Ok(value) => value,
    Err(error) => {
        return Err(error);
    }
};
let replacement_bytes = match text_bytes(request.replacement, "replacement") {
    Ok(value) => value,
    Err(error) => {
        return Err(error);
    }
};
if target_bytes == 0 {
    if original_bytes == 0 && replacement_bytes > 0 {
        return Ok(Proposal {
            path = request.path,
            before = request.original,
            after = request.replacement
        });
    }
    return Err("target must not be empty");
}

// Search again after the first matched scalar to detect every later match,
// including overlapping ones, before applying the exact byte range.
let first_index = match find(request.original, request.target) {
    Some(value) => value,
    None() => {
        return Err("literal target not found");
    }
};
let first = match char_get(request.target, 0) {
    Some(value) => from_char(value),
    None() => {
        return Err("literal match framing invalid");
    }
};
let later: Result<Option<usize>, TextError> = find_from(
    request.original,
    request.target,
    first_index + len(first)
)?;
match later {
    Ok(Some(_)) => {
        return Err("literal target is ambiguous");
    },
    Ok(None()) => (),
    Err(_) => {
        return Err("literal match framing invalid");
    }
}
if request.target == request.replacement {
    return Err("replacement leaves original unchanged");
}
// The exact match proves target_bytes <= original_bytes. Reject expansion
// before constructing any output, then replace the proven byte interval.
if original_bytes - target_bytes + replacement_bytes > file_bytes() {
    return Err("result exceeds " + from_usize(file_bytes()) + " UTF-8 bytes");
}
let changed: Result<string, TextError> = replace_range(request.original, [first_index, first_index
    + target_bytes), request.replacement)?;
let after = match changed {
    Ok(value) => value,
    Err(_) => {
        return Err("literal match framing invalid");
    }
};
return Ok(Proposal {
    path = request.path,
    before = request.original,
    after
});
}

// Recompute from the bound request; a bare before/after value is not approval,
// persistence, a current-file check or a compare-and-swap guarantee.
public flow validate(request: Request, proposal: Proposal) -> Result<Proposal, string> {
    let expected = match propose(request) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if proposal.path != expected.path || proposal.before != expected.before
        || proposal.after != expected.after {
        return Err("proposal differs from validated replacement");
    }
    return Ok(expected);
}

public type EditText = {
    target: string,
    replacement: string
};

public flow selector_error(id: string, workspace: string, path: string) -> string {
    if char_count(id) == 0 || char_count(id) > 128 || char_count(workspace) == 0
        || char_count(workspace) > 128 {
        return "invalid edit operation identity";
    }
    if !text_printable(id) || !text_printable(workspace) || trim(id) == "" || trim(workspace) == "" {
        return "invalid edit operation identity";
    }
    if !valid_path(path) {
        return "invalid relative path";
    }
    return "";
}

public flow binding_error(value: Binding) -> string {
    let invalid = selector_error(value.id, value.workspace, value.path);
    if invalid != "" {
        return invalid;
    }
    if value.region != "nomo.tools.edit_file.EditableRoot" {
        return "edit region binding mismatch";
    }
    if !hex_digest(value.request_digest) || !hex_digest(value.before_digest)
        || !hex_digest(value.after_digest) {
        return "invalid edit SHA-256 digest";
    }
    if value.before_bytes > file_bytes() || value.after_bytes > file_bytes() {
        return "invalid edit byte lengths";
    }
    if value.before_digest == value.after_digest {
        return "edit digests do not describe a change";
    }
    return "";
}

public flow record_error(value: Record) -> string {
    if value.format != 1 || (value.phase != "intent" && value.phase != "completed") {
        return "invalid edit operation format or phase";
    }
    return binding_error(value.binding);
}

public flow same_binding(left: Binding, right: Binding) -> bool {
    return left.id == right.id && left.workspace == right.workspace && left.region == right.region
        && left.path == right.path && left.request_digest == right.request_digest
        && left.before_digest == right.before_digest && left.after_digest == right.after_digest
        && left.before_bytes == right.before_bytes && left.after_bytes == right.after_bytes;
}

public flow same_record(left: Record, right: Record) -> bool {
    return left.format == right.format && left.phase == right.phase
        && same_binding(left.binding, right.binding);
}
