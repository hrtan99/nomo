module nomo.application.conversation.ports;

import std.io.IOError as ConsoleError;
import nomo.domain.conversation.session.Session;
import nomo.domain.conversation.messages.ChatMessage;

public spec ConversationPicker {
    flow choose(self, sessions: Array<Session>) -> Option<string> ![Console, Error<ConsoleError>];
}

public spec ConversationReader {
    flow load(self, id: string) -> Session ![Memory, Error<StorageError>];
    flow message(self, id: string, index: i64) -> ChatMessage ![Memory, Error<StorageError>, Error<BudgetExceeded>];
    flow messages(self, id: string, after: i64) -> Array<ChatMessage> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}

public spec ConversationWriter {
    flow append(self, id: string, role: string, name: string, text: string, call: i64) -> i64 ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
}

public spec ConversationCatalog {
    flow rename(self, id: string, title: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow create(self, workspace: string, title: string) -> Session ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow selected(self, workspace: string) -> Option<string> ![Memory, Error<StorageError>];
    flow select(self, workspace: string, id: string) -> Session ![Memory, Error<StorageError>];
    flow sessions(self, workspace: string) -> Array<Session> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
    flow all_sessions(self) -> Array<Session> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}

public spec GenerationReservation {
    flow reserve(self, id: string, compact: bool, context_bytes: usize) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}

public spec ResultPublication {
    flow prepare_result(self, id: string, role: string, name: string, call: i64) -> i64 ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow publish_result(self, id: string, index: i64, text: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
    flow result_complete(self, id: string, index: i64) -> bool ![Memory, Error<StorageError>];
    flow select_summary(self, id: string, index: i64, through: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow finish_command(self, id: string, call: i64) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
    flow acknowledge(self, id: string, call: i64, note: string) -> i64 ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
}
