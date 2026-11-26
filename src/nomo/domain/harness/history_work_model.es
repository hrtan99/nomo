module nomo.domain.harness.history_work_model;

import nomo.core.conversation.Event;
import nomo.domain.harness.harness_tool_contract.Context as ReadContext;
import nomo.domain.harness.harness_work_contract.Context as WorkContext;
import nomo.harness.harness_tool_chat_contract.Previous;

// Previous conversation is data, not a current observation, grant or receipt.
public type ReadInput = { current: ReadContext, previous_request: string, previous: Previous, conversation: Array<Event> };

public type EditInput = { current: WorkContext, previous_request: string, previous: Previous, conversation: Array<Event> };
