module nomo.application.sessions.effects.session_user_context_chain_v4;

import nomo.domain.sessions.user_context_chain_v4.RootIdentity;

// No native implementation is supplied here. Implementations must observe
// the mounted root itself and establish the lifetime of that observation.
public effect RootObservation {
    action observe() -> Result<RootIdentity, string>;
}
