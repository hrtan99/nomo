module nomo.application.conversation.requests;

import nomo.domain.configuration.settings.Settings;

public effect ConversationRequests {
    action turn(session: string, request: string, check: Option<Array<string>>) -> bool;
    action compact(session: string, settings: Settings) -> unit;
    action settings(session: string, check: Option<Array<string>>) -> Settings;
}
