module nomo.session.event_policy;

import std.fs.{Region, WorkspacePath, IOError, ReadLimitError, path, read_bytes_limited};
import std.codec.text.{utf8_decode, Strict};
import std.agent.message.Message;
import std.json.parse;
import nomo.session.redaction.{Policy, policy_error};

public type PolicyRoot;
impl PolicyRoot ~ Region;

// The caller supplies a private read-only policy directory for every process.
// This exact-literal list is not comprehensive secret detection or authority.
public flow load() -> Result<Policy, string> {
    let selected: Result<WorkspacePath<PolicyRoot>, IOError> = path<PolicyRoot>("policy.json");
    let location = match selected { Ok(item) => item, Err(_) => { return Err("event policy path refused"); } };
    return handle {
        let bytes = read_bytes_limited(location, 4096);
        let raw = match utf8_decode(bytes, Strict) { Ok(item) => item, Err(_) => { return Err("event policy must be UTF-8"); } };
        let value = match parse(raw) { Ok(item) => item, Err(_) => { return Err("event policy JSON invalid"); } };
        let converted: Option<Message<Policy>> = Message.new(value).cast<Policy>();
        let policy = match converted { Some(item) => item.body, None() => { return Err("event policy shape invalid"); } };
        let error = policy_error(policy); if error != "" { return Err(error); }
        Ok(policy)
    } with {
        Error<ReadLimitError>.raise(ReadLimitError.LimitExceeded(maximum)) => {
            if maximum != 4096 { abort("unexpected event policy read bound"); }
            finish Err("event policy exceeds bound");
        }
    };
}
