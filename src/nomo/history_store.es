module nomo.history_store;

import std.agent.session.{history_page, SessionHistoryPage};
import std.collections.len as count;
import std.json.{parse, stringify};
import nomo.bundle_codec.{Bundle, encode, decode};

flow unselected(page: SessionHistoryPage) -> bool {
    let terminal = match page.cursor { None() => true, _ => false };
    let no_context = match page.published_context { None() => true, _ => false };
    let no_summary = match page.summary { None() => true, _ => false };
    return terminal && no_context && no_summary;
}

// Provisioning is a fixture precondition. Missing/corrupt Session is never "empty".
public flow empty(key: string) -> bool {
    let page = history_page(SessionConfig.continue_or_new(key), None(), 2);
    return unselected(page) && count(page.messages) == 0;
}

public flow append(key: string, body: Bundle) -> Result<bool, string> ![Memory, Error<IndexError>] {
    let encoded = match encode(body) { Ok(value) => value, Err(error) => { return Err(error); } };
    let payload = match parse(encoded) { Ok(value) => value, Err(_) => { return Err("invalid encoded bundle"); } };
    let message = Message.with_session(Message.new(payload), SessionConfig.continue_or_new(key));
    return Ok(true);
}

public flow load(key: string) -> Result<Bundle, string> {
    let page = history_page(SessionConfig.continue_or_new(key), None(), 2);
    if !unselected(page) || count(page.messages) != 1 { return Err("expected exactly one complete bundle"); }
    let encoded = match stringify(page.messages[0].body) { Ok(value) => value, Err(_) => { return Err("unreadable bundle JSON"); } };
    return decode(encoded);
}
