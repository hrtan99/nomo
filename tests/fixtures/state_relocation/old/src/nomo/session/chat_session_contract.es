module nomo.session.chat_session_contract;

import nomo.harness.harness_tool_chat_contract.Invocation;

public type Session = {
    format: i32,
    phase: string,
    invocation: Invocation,
    last_request: string,
    pending: string
};
