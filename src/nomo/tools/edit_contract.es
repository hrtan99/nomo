module nomo.tools.edit_contract;

import std.text.len as byte_len;
import nomo.core.large_context.file_bytes;
import nomo.tools.edit_proposal.{Request, Proposal, propose};
import nomo.session.edit_operation.Binding;

public type Prepared = { request: Request, proposal: Proposal };
public type Selector = { id: string, workspace: string, path: string };
public type Confirmed = { binding: Binding, after: string };

// Reuse the complete supported original already supplied to an edit child.
// File state is still checked by apply after the durable intent.
public flow prepare_original(name: string, original: string, target: string, replacement: string) -> Result<Prepared, string> {
    let request = Request { path = name, original = original, target = target, replacement = replacement };
    let proposal = match propose(request) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Prepared { request = request, proposal = proposal });
}


public flow prepare_original_legacy(name: string, original: string, target: string, replacement: string) -> Result<Prepared, string> {
    if byte_len(original) > file_bytes() || byte_len(target) > file_bytes() || byte_len(replacement) > file_bytes() { return Err("edit text exceeds 1048576 UTF-8 bytes"); }
    let prepared = match prepare_original(name, original, target, replacement) { Ok(value) => value, Err(error) => { return Err(error); } };
    if byte_len(prepared.proposal.after) > file_bytes() { return Err("edit result exceeds 1048576 UTF-8 bytes"); }
    return Ok(prepared);
}

