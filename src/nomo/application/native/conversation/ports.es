module nomo.application.native.conversation.ports;

import nomo.domain.conversation.messages.ChatMessage;
import nomo.native.history.Session;

public spec ConversationReader {
    flow load(self, id: string) -> Session ![Memory, Error<StorageError>];
    flow message(self, id: string, index: i64) -> ChatMessage ![Memory, Error<StorageError>];
    flow messages(self, id: string, after: i64) -> Array<ChatMessage> ![Memory, Error<StorageError>];
}

public spec ConversationWriter {
    flow append(self, id: string, role: string, name: string, text: string, call: i64) -> i64 ![Memory, Error<StorageError>, Error<MemoryConflict>];
}

public spec ConversationCatalog {
    flow create(self, workspace: string, title: string) -> Session ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow selected(self, workspace: string) -> Option<string> ![Memory, Error<StorageError>];
    flow select(self, workspace: string, id: string) -> Session ![Memory, Error<StorageError>];
    flow sessions(self, workspace: string) -> Array<Session> ![Memory, Error<StorageError>];
}
