module nomo.application.context.effects;

import nomo.domain.configuration.settings.Settings;
import nomo.domain.conversation.turn.Turn;

public effect ConversationContext {
    action settings(session: string) -> Settings;
    action acquire(session: string, request: string, settings: Settings) -> Turn;
}
