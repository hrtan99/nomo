module nomo.domain.harness.conversation_events;

import nomo.core.conversation.State;

public type Turn = { state: State, status: i32 };
