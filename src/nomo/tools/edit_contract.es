module nomo.tools.edit_contract;

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

