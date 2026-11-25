module nomo.bootstrap.execution;

import nomo.native.lifecycle.Attempt;
import nomo.adapters.etas.attempts.NativeAttempts;
import nomo.adapters.etas.conversations.NativeHistory;
import nomo.application.native.execution.ports.AttemptRepository;
import nomo.application.native.execution.service.{turn_available as require_turn, begin as prepare_attempt,
    dispatching as dispatch_attempt, returned as publish_return, complete_attempt as complete, resolve as reconcile};

public flow attempts(session: string, unresolved: bool) -> Array<Attempt> ![Memory, Error<StorageError>] {
    return (NativeAttempts {}).list(session, unresolved);
}

public flow turn_available(session: string) -> unit ![Memory, Error<StorageError>] {
    require_turn(NativeAttempts {}, session);
}

public flow begin(session: string, kind: string, label: string, input_event: i64, through: i64) -> Attempt
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    return prepare_attempt(NativeAttempts {}, session, kind, label, input_event, through);
}

public flow dispatching(id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    dispatch_attempt(NativeAttempts {}, id);
}

public flow returned(id: string, role: string, name: string, text: string, call: i64) -> i64
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    return publish_return(NativeAttempts {}, NativeHistory {}, id, role, name, text, call);
}

public flow complete_attempt(id: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    complete(NativeAttempts {}, NativeHistory {}, NativeHistory {}, id);
}

public flow resolve(session: string, id: string, note: string) -> Attempt
    ![Memory, Error<StorageError>, Error<MemoryConflict>] {
    return reconcile(NativeAttempts {}, NativeHistory {}, NativeHistory {}, NativeHistory {}, session, id, note);
}
