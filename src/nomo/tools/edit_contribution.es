module nomo.tools.edit_contribution;

import nomo.tools.edit_proposal.{Request, Proposal, propose};

public type Contribution = { target: string, replacement: string };

// The caller owns path/original; this value grants no File or approval authority.
// Reuse the complete literal, uniqueness, NUL/UTF-8 and changed-result guards.
public flow project(path: string, original: string, value: Contribution) -> Result<Proposal, string> {
    return propose(Request { path = path, original = original, target = value.target, replacement = value.replacement });
}
