module nomo.bootstrap.chat;

import nomo.domain.sessions.redaction.Policy;
import nomo.adapters.storage.chat_repositories.{LegacyChatRepository, RecoverableChatRepository};

public flow legacy_repository() -> LegacyChatRepository { return LegacyChatRepository {}; }
public flow recoverable_repository(redaction: Policy, binding: string, high_input: bool) -> RecoverableChatRepository {
    return RecoverableChatRepository { redaction, binding, high_input };
}
