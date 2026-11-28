module nomo.domain.sessions.user_context_chain_v4_context;

import nomo.domain.sessions.chain.{ParentFacts, parent_facts as chain_parent_facts};
import nomo.domain.sessions.user_context_chain_v4.{Record, RootIdentity, validate};

// Captured facts remain untrusted data. This pure projection proves neither
// the observed root's authority nor permission to start a new turn.
public flow parent_facts(parent: Record, observed: RootIdentity) -> Result<Array<ParentFacts>, string> {
    let error = validate(parent);
    if error != "" {
        return Err(error);
    }
    if parent.root != observed {
        return Err("v4 parent read-root identity changed");
    }
    return chain_parent_facts(parent.base);
}
