module nomo.application.sessions.effects.session_work_chain_discovery;

import nomo.session.work_chain.Record;
import nomo.domain.sessions.work_chain_selection.ObservedRow;

public effect DiscoveryAuthority {
    action inspect(id: string, workspace: string, path: string) -> Result<Option<Record>, string>;
    action confirmed_parent(id: string, workspace: string, path: string) -> Result<ObservedRow, string>;
}
