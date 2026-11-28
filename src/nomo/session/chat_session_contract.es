module nomo.session.chat_session_contract;

import nomo.harness.harness_tool_chat_contract.Invocation;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// Persistent conversation data never carries filesystem authority or consent.
// An in-flight reservation remains unresolved after a restart; it cannot retry.
public type Session = {
    format: i32,
    phase: string,
    invocation: Invocation,
    last_request: string,
    pending: string
};
