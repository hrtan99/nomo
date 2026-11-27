module nomo.application.sessions.ports.prior_chat;

import nomo.domain.sessions.chat_history.Entry;

public spec PriorChatReader {
    flow load(self) -> Result<Option<Entry>, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}
