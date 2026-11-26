module nomo.adapters.storage.mutation_history;

import std.json.JsonValue;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.conversation.session.Session;
import nomo.domain.conversation.history.PendingRequest;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.adapters.storage.conversations.{NativeHistory, record as save_record, tool_finished, pending_request, result_published};
import nomo.application.mutations.ports.MutationHistoryStore;

public type NativeMutationHistory = {};
impl NativeMutationHistory ~ MutationHistoryStore {
    flow record(self, role: string, name: string, value: JsonValue, call: i64) -> i64 ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] { return save_record(role, name, value, call); }
    flow finish(self, name: string, call: i64, value: JsonValue) -> unit ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] { tool_finished(name, call, value); }
    flow session(self, id: string) -> Session ![Memory, Error<StorageError>] { return (NativeHistory {}).load(id); }
    flow pending(self, id: string) -> Option<PendingRequest> ![Memory, Error<StorageError>] { return pending_request(id); }
    flow message(self, id: string, index: i64) -> ChatMessage ![Memory, Error<StorageError>] { return (NativeHistory {}).message(id, index); }
    flow published(self, id: string, call: i64, name: string) -> bool ![Memory, Error<StorageError>] { return result_published(id, call, name); }
}
