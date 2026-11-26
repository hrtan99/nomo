module nomo.domain.harness.text_stage;

import nomo.core.conversation.Event;

// Copied conversation data only. The caller owns the attempt and its budget.
public type Context = { history: Array<Event>, request: string };
