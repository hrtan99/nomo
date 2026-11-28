module nomo.application.sessions.user_context_chain;

import nomo.application.sessions.effects.session_user_context_chain_v4.RootObservation;
import nomo.domain.sessions.chain.{Caps, initial, successor};
import nomo.domain.sessions.user_context_chain_v4.{
    RootBoundWorkChain,
    initial as user_context_chain_v4_initial,
    successor as user_context_chain_v4_successor,
    validate
};

public flow initial_observed(
    id: string,
    workspace: string,
    path: string,
    request: string,
    allowed: Array<string>,
    policy: Caps
) -> Result<RootBoundWorkChain, string> ![RootObservation.observe, Error<IndexError>, Error<BudgetExceeded>] {
    match initial(id, workspace, path, request, allowed, policy) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let observed = match perform RootObservation.observe() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return user_context_chain_v4_initial(id, workspace, path, request, allowed, policy, observed);
}

public flow successor_observed(
    parent: RootBoundWorkChain,
    parent_version: string,
    id: string,
    request: string,
    allowed: Array<string>,
    policy: Caps
) -> Result<RootBoundWorkChain, string> ![RootObservation.observe, Error<IndexError>, Error<BudgetExceeded>] {
    let invalid = validate(parent);
    if invalid != "" {
        return Err(invalid);
    }
    match successor(parent.base, parent_version, id, request, allowed, policy) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    let observed = match perform RootObservation.observe() {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return user_context_chain_v4_successor(parent, parent_version, id, request, allowed, policy, observed);
}
