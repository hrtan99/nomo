module fixture.setup;

import std.agent.session.Conversation;
import nomo.domain.sessions.store_record.session_key;

// Setup-only namespace provisioning. This flow is never called by save/reload.
flow main(args: Array<string>) -> bool {
    if args.len() != 2 { return false; }
    let config = SessionConfig.continue_or_new(session_key(args[0], args[1]));
    let _history = Conversation.load(config);
    return true;
}
