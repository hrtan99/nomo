module nomo.adapters.model.tools.mutations;

import nomo.application.conversation.session_context.SessionContext;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.domain.mutations.models.{Change, ChangeOutcome, Journal as JournalView};

public flow apply_plan(name: string, changes: Array<Change>) -> ChangeOutcome ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.apply(perform SessionContext.current(), name, changes);
}

/// Apply related create/write/edit/mkdir/delete/move operations. Every actual native mutation has its own Host approval. Returns a durable edit ID for undo/recovery.
public tool apply_changes(changes: Array<Change>) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return apply_plan("apply_changes", changes);
}

/// Create a UTF-8 file, including missing parent directories. Existing targets are refused.
public tool create_file(pathname: string, content: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return apply_plan("create_file", [Change { operation = "create", path = pathname, target = "", text = content }]);
}

/// Write a UTF-8 file, retaining its previous state for undo.
public tool write_file(pathname: string, content: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return apply_plan("write_file", [Change { operation = "write", path = pathname, target = "", text = content }]);
}

/// Create a project directory and missing parents.
public tool make_directory(pathname: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return apply_plan("make_directory", [Change { operation = "mkdir", path = pathname, target = "", text = "" }]);
}

/// Delete a project file or directory after snapshotting it for undo.
public tool delete_path(pathname: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return apply_plan("delete_path", [Change { operation = "delete", path = pathname, target = "", text = "" }]);
}

/// Move a project file or directory to an absent destination, retaining snapshots for undo.
public tool move_path(source: string, destination: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return apply_plan("move_path", [Change { operation = "move", path = source, target = destination, text = "" }]);
}

/// Undo the selected journal (empty edit selects the latest applied journal). Current contents must match its saved result. Native Host approval applies to every restoration operation.
public tool undo_changes(edit: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.undo(perform SessionContext.current(), edit);
}

/// Explicitly restore an interrupted/partial transaction from its durable before snapshots, after reviewing actual state. This never replays the requested forward changes.
public tool rollback_changes(edit: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.rollback(perform SessionContext.current(), edit);
}

/// Inspect this conversation's durable edit phases, including an interrupted edit, without starting another mutation.
public tool list_changes() -> Array<JournalView>
    ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.inspect(perform SessionContext.current());
}

/// Reconcile a completed journal/result after interruption without executing any project operation. Unfinished changes still require explicit rollback.
public tool reconcile_changes(edit: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.reconcile(perform SessionContext.current(), edit);
}

public flow journals() -> Array<JournalView> ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.list(perform SessionContext.current());
}
