module nomo.tools.edit_binding;

import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.tools.edit_file.Prepared;
import nomo.tools.edit_proposal.validate;
import nomo.tools.edit_encoding.{json, digest};
import nomo.session.edit_operation.{Binding, binding_error, selector_error};

let REGION = "nomo.tools.edit_file.EditableRoot";

public flow bind(id: string, workspace: string, path: string, value: Prepared) -> Result<Binding, string> {
    let invalid_selector = selector_error(id, workspace, path); if invalid_selector != "" { return Err(invalid_selector); }
    if path != value.request.path || path != value.proposal.path { return Err("edit selector differs from prepared request"); }
    match validate(value.request, value.proposal) { Ok(_) => {} Err(error) => { return Err(error); } }
    let proposal = value.proposal;
    let canonical = match json(["nomo-edit-request-v1", id, workspace, REGION, proposal.path,
        proposal.before, value.request.target, value.request.replacement, proposal.after]) { Ok(item) => item, Err(error) => { return Err(error); } };
    let before = match digest(proposal.before) { Ok(item) => item, Err(error) => { return Err(error); } };
    let after = match digest(proposal.after) { Ok(item) => item, Err(error) => { return Err(error); } };
    let request = match digest(canonical) { Ok(item) => item, Err(error) => { return Err(error); } };
    let result = Binding { id = id, workspace = workspace, region = REGION, path = proposal.path,
        request_digest = request, before_digest = before, after_digest = after,
        before_bytes = byte_count(utf8_encode(proposal.before)), after_bytes = byte_count(utf8_encode(proposal.after)) };
    let invalid = binding_error(result); if invalid != "" { return Err(invalid); }
    return Ok(result);
}

