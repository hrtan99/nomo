module nomo.application.harness.effects.model_conversation_output;

import nomo.core.conversation.Event;

public effect ConversationOutput { action publish(event: Event) -> unit; }
