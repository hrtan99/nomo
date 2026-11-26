module nomo.domain.harness.read_tool_chat;

import nomo.domain.harness.harness_tool_chat_contract.Context;
import nomo.core.conversation.Event;

public type ConversationInput = { current: Context, history: Array<Event> };

public enum MainMode { Standard, Wide, HighInput, Large, Full }
