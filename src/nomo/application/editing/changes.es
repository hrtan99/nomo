module nomo.application.editing.changes;

import nomo.domain.changes.ChangeCommand;
import nomo.domain.changes.{
    FileChangeOperation,
    JournalPhase,
    StepPhase,
    ChangeStatus,
    wire_change,
    wire_change_outcome,
    wire_file_outcome,
    wire_journal
};
import nomo.application.conversation.ports.ConversationReader;
import nomo.application.editing.ports.{
    ChangeJournal,
    ChangeJournalStore,
    ChangeOperations,
    MutationFileAccess,
    MutationFiles,
    MutationHistory,
    MutationHistoryStore,
    MutationOutput,
    MutationOutputSink
};
import nomo.application.execution.ports.CommandOperations;
import nomo.application.resources.ProjectRoot;
import nomo.application.scope.SessionContext;
import nomo.domain.changes.{
    Change,
    ChangeOutcome,
    FileChange,
    FileOutcome,
    FilePreview,
    FileJournal,
    PlanRequest,
    SavedPath,
    FileStep,
    below_root,
    completed_phase,
    content_change,
    creates_parents,
    file_request,
    literal_after,
    parent,
    requires_existing,
    restoring_phase
};
import nomo.domain.conversation.{ChatMessage, PendingRequest};
import nomo.domain.wire.encode;
import std.agent.message.Message;
import std.effects.Fs;
import std.fs.{IOError, ReadLimitError};
import std.io.IOError as io_IOError;
import std.json.{JsonValue, parse};
import std.text.{from_i64, from_usize, split};

flow bindings<
    F ~ MutationFileAccess,
    J ~ ChangeJournalStore,
    H ~ MutationHistoryStore
        + ConversationReader,
    O ~ MutationOutputSink
>(files: F, journals: J, history: H, output: O) -> ![
    MutationFiles,
    ChangeJournal,
    MutationHistory,
    MutationOutput => SessionContext.current,
    CommandOperations,
    Memory,
    Console,
    Command.run<DefaultCommandSandbox>,
    Fs.read<ProjectRoot>,
    Fs.list<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<ReadLimitError>,
    Error<io_IOError>,
    Error<BudgetExceeded>
] ![] {
    return handler {
        MutationFiles.backup(id) => files.backup(id);
        MutationFiles.normalize(path) => files.normalize(path);
        MutationFiles.exists(path) => files.exists(path);
        MutationFiles.read(path) => files.read(path);
        MutationFiles.replace(path, text) => files.replace(path, text);
        MutationFiles.command(program, arguments, call) => files.command(program, arguments, call);
        ChangeJournal.lookup(id) => journals.lookup(id);
        ChangeJournal.insert(value) => journals.insert(value);
        ChangeJournal.save(value) => journals.save(value);
        ChangeJournal.step(key) => journals.step(key);
        ChangeJournal.save_step(key, value) => journals.save_step(key, value);
        ChangeJournal.list(selected) => journals.list(selected);
        MutationHistory.record(role, name, value, call) => history.record(role, name, value, call);
        MutationHistory.finish(name, call, value) => history.finish(name, call, value);
        MutationHistory.session(id) => history.load(id);
        MutationHistory.pending(id) => history.pending(id);
        MutationHistory.message(id, index) => history.message(id, index);
        MutationHistory.published(id, call, name) => history.published(id, call, name);
        MutationOutput.write(line) => output.write(line);
    };
}

public flow mutations_handlers_execute<
    F ~ MutationFileAccess,
    J ~ ChangeJournalStore,
    H ~ MutationHistoryStore
        + ConversationReader,
    O ~ MutationOutputSink
>(
    files: F,
    journals: J,
    history: H,
    output: O,
    session: string,
    request: ChangeCommand
) -> ChangeOutcome
![
    CommandOperations,
    Memory,
    Console,
    Command.run<DefaultCommandSandbox>,
    Fs.read<ProjectRoot>,
    Fs.list<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<ReadLimitError>,
    Error<io_IOError>,
    Error<BudgetExceeded>
] {
    return handle (
        mutations_service_execute(request) with bindings(
            files,
            journals,
            history,
            output
        )
    ) with {
        SessionContext.current() => session;
    };
}

public flow replace<
    F ~ MutationFileAccess,
    J ~ ChangeJournalStore,
    H ~ MutationHistoryStore
        + ConversationReader,
    O ~ MutationOutputSink
>(files: F, journals: J, history: H, output: O, session: string, change: FileChange) -> FileOutcome
![
    CommandOperations,
    Memory,
    Console,
    Command.run<DefaultCommandSandbox>,
    Fs.read<ProjectRoot>,
    Fs.list<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<ReadLimitError>,
    Error<io_IOError>,
    Error<BudgetExceeded>
] {
    return handle (replace_file(change) with bindings(files, journals, history, output)) with {
        SessionContext.current() => session;
    };
}

public flow mutations_handlers_list<
    F ~ MutationFileAccess,
    J ~ ChangeJournalStore,
    H ~ MutationHistoryStore
        + ConversationReader,
    O ~ MutationOutputSink
>(files: F, journals: J, history: H, output: O, session: string, observing: bool) -> Array<FileJournal>
![
    CommandOperations,
    Memory,
    Console,
    Command.run<DefaultCommandSandbox>,
    Fs.read<ProjectRoot>,
    Fs.list<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<ReadLimitError>,
    Error<io_IOError>,
    Error<BudgetExceeded>
] {
    return handle (mutations_service_list(observing) with bindings(files, journals, history, output)) with {
        SessionContext.current() => session;
    };
}

public flow operations<
    F ~ MutationFileAccess,
    J ~ ChangeJournalStore,
    H ~ MutationHistoryStore
        + ConversationReader,
    O ~ MutationOutputSink
>(files: F, journals: J, history: H, output: O) -> ![
    ChangeOperations => CommandOperations,
    Memory,
    Console,
    Command.run<DefaultCommandSandbox>,
    Fs.read<ProjectRoot>,
    Fs.list<ProjectRoot>,
    Fs.atomic_replace<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<ReadLimitError>,
    Error<io_IOError>,
    Error<BudgetExceeded>
] ![] {
    return handler {
        ChangeOperations.apply(session, name, changes) => mutations_handlers_execute(
            files,
            journals,
            history,
            output,
            session,
            ChangeCommand.Apply(name, changes)
        );
        ChangeOperations.undo(session, edit) => mutations_handlers_execute(
            files,
            journals,
            history,
            output,
            session,
            ChangeCommand.Undo(edit)
        );
        ChangeOperations.rollback(session, edit) => mutations_handlers_execute(
            files,
            journals,
            history,
            output,
            session,
            ChangeCommand.Rollback(edit)
        );
        ChangeOperations.reconcile(session, edit) => mutations_handlers_execute(
            files,
            journals,
            history,
            output,
            session,
            ChangeCommand.Reconcile(edit)
        );
        ChangeOperations.replace(session, change) => replace(
            files,
            journals,
            history,
            output,
            session,
            change
        );
        ChangeOperations.list(session) => mutations_handlers_list(
            files,
            journals,
            history,
            output,
            session,
            false
        );
        ChangeOperations.inspect(session) => mutations_handlers_list(
            files,
            journals,
            history,
            output,
            session,
            true
        );
    };
}

flow text<T>(value: T) -> string {
    return match encode(value, "change conversion failed", "change encoding failed") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
}

flow checked(name: string) -> string {
    return below_root(perform MutationFiles.normalize(name));
}

flow exists(name: string) -> bool {
    return perform MutationFiles.exists(name);
}

flow read_text(name: string) -> string {
    return perform MutationFiles.read(name);
}

flow println(line: string) -> unit {
    perform MutationOutput.write(line);
}

flow as_json<T>(value: T) -> JsonValue {
    let result: Option<Message<JsonValue>> = Message.new(value).cast<JsonValue>();
    return match result {
        Some(value) => value.body,
        None() => abort("history conversion failed"),
    };
}

flow record<T>(role: string, name: string, value: T, call: i64) -> i64 {
    return perform MutationHistory.record(role, name, as_json(value), call);
}

flow tool_finished<T>(name: string, call: i64, value: T) -> unit {
    perform MutationHistory.finish(name, call, as_json(value));
}

flow observe_started<T>(name: string, value: T) -> i64 {
    return record("observation_call", name, value, -1);
}

flow observe_finished<T>(name: string, call: i64, value: T) -> unit {
    record("tool", name, value, call);
}

flow pending_request(id: string) -> Option<PendingRequest> {
    return perform MutationHistory.pending(id);
}

flow message(id: string, index: i64) -> ChatMessage {
    return perform MutationHistory.message(id, index);
}

flow result_published(id: string, call: i64, name: string) -> bool {
    return perform MutationHistory.published(id, call, name);
}

flow journal(id: string) -> FileJournal {
    let value = match perform ChangeJournal.lookup(id) {
        Some(value) => value,
        None() => abort("native edit journal not found"),
    };
    let session = perform SessionContext.current();
    if value.session != session {
        abort("edit belongs to a different conversation");
    }
    return value;
}

flow update(value: FileJournal, phase: JournalPhase, steps: i64, message: string) -> FileJournal {
    let result = value {
        phase,
        steps,
        message
    };
    perform ChangeJournal.save(result);
    return result;
}

flow command(program: string, arguments: Array<string>, call: i64) -> bool {
    return perform MutationFiles.command(program, arguments, call);
}

flow backup_root(value: FileJournal) -> string {
    return perform MutationFiles.backup(value.id);
}

flow step_key(id: string, index: i64) -> string {
    return id + "/" + from_i64(index);
}

flow save_before(value: FileJournal, index: i64, name: string, slot: usize) -> Option<SavedPath> {
    let saved = backup_root(value) + "/" + from_i64(index) + "-" + from_usize(slot);
    let present = exists(name);
    if present && !command("/bin/cp", ["-a", "--", name, saved + ".before"], value.call) {
        return None();
    }
    return Some(
        SavedPath {
            path = name,
            before_exists = present,
            before = saved + ".before",
            after_exists = false,
            after = saved + ".after"
        }
    );
}

flow apply_step(id: string, change: Change) -> bool {
    let value = journal(id);
    let name = checked(change.path);
    if change.operation == FileChangeOperation.Create && exists(name) {
        update(value, JournalPhase.Failed, value.steps, "create target already exists");
        return false;
    }
    if requires_existing(change.operation) && !exists(name) {
        update(value, JournalPhase.Failed, value.steps, "change source does not exist");
        return false;
    }
    let target = if change.operation == FileChangeOperation.Move {
        checked(change.target)
    } else {
        ""
    };
    if change.operation == FileChangeOperation.Move && exists(target) {
        update(value, JournalPhase.Failed, value.steps, "move destination already exists");
        return false;
    }
    let index = value.steps;
    let key = step_key(id, index);
    var paths: Array<SavedPath> = [];
    let before = match save_before(value, index, name, 0) {
        Some(value) => value,
        None() => {
            update(
                value,
                JournalPhase.Failed,
                index,
                "before snapshot failed; project mutation not dispatched"
            );
            return false;
        }
    };
    paths = paths.push(before);
    if change.operation == FileChangeOperation.Move {
        let destination = match save_before(value, index, target, 1) {
            Some(value) => value,
            None() => {
                update(value, JournalPhase.Failed, index, "destination snapshot failed");
                return false;
            }
        };
        paths = paths.push(destination);
    }
    // Publish the recovery material before a project mutation can start.
    perform ChangeJournal.save_step(key, FileStep {
        phase = StepPhase.Prepared,
        paths
    });
    let active = update(value, JournalPhase.Applying, index + 1, "");
    record("edit_step", "prepared", change, value.call);
    println("[CHANGE ] " + text(wire_change(change)));
    var applied = false;
    if content_change(change.operation) {
        let original = if before.before_exists {
            read_text(name)
        } else {
            ""
        };
        var after = change.text;
        if change.operation == FileChangeOperation.Edit {
            after = match literal_after(original, change.target, change.text) {
                Ok(value) => value,
                Err(error) => {
                    update(active, JournalPhase.Failed, active.steps, error);
                    return false;
                }
            };
        }
        let preview = FilePreview {
            path = name,
            before = original,
            after
        };
        record("edit_preview", "file", preview, value.call);
        println("[PREVIEW] " + text(preview));
        perform ChangeJournal.save_step(key, FileStep {
            phase = StepPhase.Applying,
            paths
        });
        perform MutationFiles.replace(name, after);
        applied = true;
    }
    else if change.operation == FileChangeOperation.Mkdir {
        perform ChangeJournal.save_step(key, FileStep {
            phase = StepPhase.Applying,
            paths
        });
        applied = command("/bin/mkdir", ["-p", "--", name], value.call);
    }
    else if change.operation == FileChangeOperation.Delete {
        perform ChangeJournal.save_step(key, FileStep {
            phase = StepPhase.Applying,
            paths
        });
        applied = command("/bin/rm", ["-rf", "--", name], value.call);
    }
    else if change.operation == FileChangeOperation.Move {
        perform ChangeJournal.save_step(key, FileStep {
            phase = StepPhase.Applying,
            paths
        });
        applied = command("/bin/mv", ["-T", "--no-clobber", "--", name, target], value.call);
    }
    else {
        update(active, JournalPhase.Failed, active.steps, "unknown file operation");
        return false;
    }
    if !applied {
        update(
            active,
            JournalPhase.Failed,
            active.steps,
            "native project operation failed; inspect or roll back this journal"
        );
        return false;
    }
    if change.operation == FileChangeOperation.Move && exists(name) {
        update(
            active,
            JournalPhase.Failed,
            active.steps,
            "move did not remove the source; inspect retained state"
        );
        return false;
    }
    var published: Array<SavedPath> = [];
    for item in paths {
        let present = exists(item.path);
        if present && !command("/bin/cp", ["-a", "--", item.path, item.after], value.call) {
            update(
                active,
                JournalPhase.Failed,
                active.steps,
                "after snapshot failed; project mutation may already be complete"
            );
            return false;
        }
        published = published.push(item {
            after_exists = present
        });
    }
    perform ChangeJournal.save_step(key, FileStep {
        phase = StepPhase.Applied,
        paths = published
    });
    record("edit_step_result", "applied", change, value.call);
    return true;
}

flow parents(id: string, name: string) -> bool {
    var prefix = "";
    for component in split(parent(name), "/") {
        if component != "." && component != "" {
            prefix = if prefix == "" {
                component
            } else {
                prefix + "/" + component
            };
            if !exists(prefix) && !apply_step(
                id,
                Change {
                    operation = FileChangeOperation.Mkdir,
                    path = prefix,
                    target = "",
                    text = ""
                }
            ) {
                return false;
            }
        }
    }
    return true;
}

flow completed_steps(value: FileJournal) -> i64 {
    var completed: i64 = 0;
    var index: i64 = 0;
    @limits([Iterations(2147483647)]) while index < value.steps {
        match perform ChangeJournal.step(step_key(value.id, index)) {
            Some(step) => {
                if step.phase == StepPhase.Applied {
                    completed = completed + 1;
                }
            },
            None() => (),
        }
        index = index + 1;
    }
    return completed;
}

flow outcome(value: FileJournal, status: ChangeStatus) -> ChangeOutcome {
    let completed = completed_steps(value);
    return ChangeOutcome {
        edit = value.id,
        status,
        completed,
        message = value.message
    };
}

public flow apply_plan(name: string, changes: Array<Change>) -> ChangeOutcome ![
    SessionContext.current,
    MutationFiles,
    ChangeJournal,
    MutationHistory,
    MutationOutput,
    Error<BudgetExceeded>
] {
    require_settled_edits();
    let session = perform SessionContext.current();
    let call = record(
        "tool_call",
        name,
        PlanRequest {
            format = "nomo-native-file-plan-1",
            changes = changes.iter().map(change => wire_change(change)).collect()
        },
        -1
    );
    let id = session + "-" + from_i64(call);
    let value = FileJournal {
        id,
        session,
        name,
        call,
        phase = JournalPhase.Preparing,
        steps = 0,
        message = "",
        owner_call = call,
        owner_name = name
    };
    perform ChangeJournal.insert(value);
    println("[BATCH  ] " + text(changes.iter().map(change => wire_change(change)).collect()));
    if !command("/bin/mkdir", ["-p", "--", backup_root(value)], call) {
        let failed = update(
            value,
            JournalPhase.Failed,
            0,
            "backup directory creation failed; project mutations not dispatched"
        );
        let result = outcome(failed, ChangeStatus.RecoveryRequired);
        record("partial_result", name, wire_change_outcome(result), call);
        return result;
    }
    for change in changes {
        let normalized = checked(change.path);
        if creates_parents(change.operation) {
            if !parents(id, normalized) {
                let result = outcome(journal(id), ChangeStatus.RecoveryRequired);
                record("partial_result", name, wire_change_outcome(result), call);
                return result;
            }
        }
        if change.operation == FileChangeOperation.Move && !parents(id, checked(change.target)) {
            let result = outcome(journal(id), ChangeStatus.RecoveryRequired);
            record("partial_result", name, wire_change_outcome(result), call);
            return result;
        }
        if !apply_step(id, change) {
            let result = outcome(journal(id), ChangeStatus.RecoveryRequired);
            record("partial_result", name, wire_change_outcome(result), call);
            return result;
        }
    }
    let latest = journal(id);
    let complete = update(latest, JournalPhase.Applied, latest.steps, "");
    let result = outcome(complete, ChangeStatus.Applied);
    tool_finished(name, call, wire_change_outcome(result));
    return result;
}

public flow journals() -> Array<FileJournal> ![SessionContext.current, ChangeJournal] {
    let session = perform SessionContext.current();
    return perform ChangeJournal.list(session);
}

flow require_settled_edits() -> unit ![SessionContext.current, ChangeJournal] {
    for value in journals() {
        if !completed_phase(value.phase) {
            abort("unfinished edit requires explicit rollback before another mutation");
        }
    }
}

flow selected_edit(id: string) -> FileJournal {
    if id != "" {
        return journal(id);
    }
    var selected: Option<FileJournal> = None();
    for item in journals() {
        if item.phase == JournalPhase.Applied {
            match selected {
                Some(previous) => {
                    if item.call > previous.call {
                        selected = Some(item);
                    }
                },
                None() => {
                    selected = Some(item);
                }
            }
        }
    }
    return match selected {
        Some(value) => value,
        None() => abort("no applied native edit to undo"),
    };
}

flow imported_edit(value: FileJournal) -> bool {
    let origin = message(value.session, value.call);
    return origin.role == "archive" && origin.name == "migrated_project_edit";
}

flow restore(value: FileJournal, call: i64, checking: bool) -> bool {
    var index = value.steps - 1;
    @limits([Iterations(2147483647)]) while index >= 0 {
        let key = step_key(value.id, index);
        let step = match perform ChangeJournal.step(key) {
            Some(value) => value,
            None() => abort("native edit step missing"),
        };
        if restoring_phase(step.phase) {
            for item in step.paths {
                let present = exists(item.path);
                if checking {
                    if present != item.after_exists {
                        return false;
                    }
                    if present
                        && !command(
                        "/usr/bin/diff",
                        ["-r", "--no-dereference", "--", item.path, item.after],
                        call
                    ) {
                        return false;
                    }
                }
            }
            perform ChangeJournal.save_step(key, step {
                phase = StepPhase.Restoring
            });
            for item in step.paths {
                println("[RESTORE] " + text(item));
                if exists(item.path) && !command("/bin/rm", ["-rf", "--", item.path], call) {
                    return false;
                }
                if item.before_exists && !command("/bin/cp", ["-a", "--", item.before, item.path], call) {
                    return false;
                }
            }
            perform ChangeJournal.save_step(key, step {
                phase = StepPhase.Restored
            });
            record("edit_step_result", "restored", key, call);
        }
        index = index - 1;
    }
    return true;
}

/// Undo the selected journal (empty edit selects the latest applied journal). Current contents must match its saved result. Native Host approval applies to every restoration operation.
public flow undo_changes(edit: string) -> ChangeOutcome ![
    SessionContext.current,
    MutationFiles,
    ChangeJournal,
    MutationHistory,
    MutationOutput,
    Error<BudgetExceeded>
] {
    require_settled_edits();
    let source = selected_edit(edit);
    if source.phase != JournalPhase.Applied {
        abort("only an applied edit can start undo; use rollback_changes for interrupted edits");
    }
    let call = record("tool_call", "undo_changes", source.id, -1);
    let active = source {
        phase = JournalPhase.Undoing,
        message = "",
        owner_call = call,
        owner_name = "undo_changes"
    };
    perform ChangeJournal.save(active);
    if !restore(active, call, true) {
        let failed = update(
            active,
            JournalPhase.Undoing,
            active.steps,
            "undo stopped; current content may have changed or a restoration failed"
        );
        let result = outcome(failed, ChangeStatus.RecoveryRequired);
        record("partial_result", "undo_changes", wire_change_outcome(result), call);
        return result;
    }
    let complete = update(active, JournalPhase.Undone, active.steps, "");
    let result = outcome(complete, ChangeStatus.Undone);
    tool_finished("undo_changes", call, wire_change_outcome(result));
    return result;
}

/// Explicitly restore an interrupted/partial transaction from its durable before snapshots, after reviewing actual state. This never replays the requested forward changes.
public flow rollback_changes(edit: string) -> ChangeOutcome ![
    SessionContext.current,
    MutationFiles,
    ChangeJournal,
    MutationHistory,
    MutationOutput,
    Error<BudgetExceeded>
] {
    let source = journal(edit);
    if completed_phase(source.phase) {
        abort("journal has no interrupted change to roll back");
    }
    let session = perform MutationHistory.session(source.session);
    var active = source;
    var call = source.owner_call;
    var name = source.owner_name;
    let binding = source.session + ":" + from_i64(call) + " " + name;
    if session.pending == "" && imported_edit(source) {
        call = record("tool_call", "rollback_changes", source.id, -1);
        name = "rollback_changes";
        active = source {
            owner_call = call,
            owner_name = name
        };
        perform ChangeJournal.save(active);
    } else if session.pending != binding {
        abort("rollback does not match the selected conversation's pending operation");
    }
    record("recovery", "rollback_changes", source.id, call);
    if !restore(active, call, false) {
        let result = outcome(journal(edit), ChangeStatus.RecoveryRequired);
        record("partial_result", "rollback_changes", wire_change_outcome(result), call);
        return result;
    }
    let complete = update(active, JournalPhase.RolledBack, active.steps, "");
    let result = outcome(complete, ChangeStatus.RolledBack);
    record("recovery_result", "rollback_changes", wire_change_outcome(result), call);
    tool_finished(name, call, wire_change_outcome(result));
    return result;
}

/// Inspect this conversation's durable edit phases, including an interrupted edit, without starting another mutation.
public flow list_changes() -> Array<FileJournal> ![SessionContext.current, ChangeJournal, MutationHistory] {
    let call = observe_started("list_changes", "");
    let result = journals();
    observe_finished("list_changes", call, result.iter().map(row => wire_journal(row)).collect());
    return result;
}

/// Reconcile a completed journal/result after interruption without executing any project operation. Unfinished changes still require explicit rollback.
public flow reconcile_changes(edit: string) -> ChangeOutcome ![
    SessionContext.current,
    MutationFiles,
    ChangeJournal,
    MutationHistory,
    MutationOutput,
    Error<BudgetExceeded>
] {
    let session = perform SessionContext.current();
    let pending = match pending_request(session) {
        Some(value) => value,
        None() => {
            return ChangeOutcome {
                edit,
                status = ChangeStatus.NoPendingRequest,
                completed = 0,
                message = "No pending operation needs reconciliation."
            };
        }
    };
    let source = match perform ChangeJournal.lookup(edit) {
        Some(value) => value,
        None() => {
            let expected = session + "-" + from_i64(pending.call);
            let is_file_request = file_request(pending.name);
            if edit != expected {
                abort("edit ID does not match the pending request");
            }
            if result_published(session, pending.call, pending.name) {
                let result = ChangeOutcome {
                    edit,
                    status = ChangeStatus.RecordedResultRetained,
                    completed = 0,
                    message = "The existing complete result was retained; no project operation was replayed."
                };
                record("recovery", "reconcile_changes", wire_change_outcome(result), pending.call);
                tool_finished(pending.name, pending.call, wire_change_outcome(result));
                return result;
            }
            var undispatched = !pending.complete;
            if pending.complete && is_file_request {
                let body = match parse(message(session, pending.call).text) {
                    Ok(value) => value,
                    Err(_) => abort("pending request is not JSON"),
                };
                let converted: Option<Message<PlanRequest>> = Message.new(body).cast<PlanRequest>();
                undispatched = match converted {
                    Some(value) => value.body.format == "nomo-native-file-plan-1",
                    None() => false
                };
            }
            if !undispatched {
                return ChangeOutcome {
                    edit,
                    status = ChangeStatus.RecoveryRequired,
                    completed = 0,
                    message = "An older or unjournalled operation has no recorded outcome. Inspect actual state; execution is not inferred and the request remains pending."
                };
            }
            // Versioned file plans insert their journal before dispatch. Older
            // unversioned records do not establish this invariant.
            let result = ChangeOutcome {
                edit,
                status = ChangeStatus.NotDispatched,
                completed = 0,
                message = "Request preparation stopped before project dispatch; no operation was replayed."
            };
            record("recovery", "reconcile_changes", wire_change_outcome(result), pending.call);
            tool_finished(pending.name, pending.call, wire_change_outcome(result));
            return result;
        }
    };
    if source.session != session {
        abort("edit belongs to another conversation");
    }
    let unclaimed_undo = source.phase == JournalPhase.Applied && pending.name == "undo_changes";
    let unclaimed_rollback = pending.name == "rollback_changes" && imported_edit(source);
    if (unclaimed_undo || unclaimed_rollback) && pending.complete
        && message(session, pending.call).text == text(source.id) && source.owner_call != pending.call {
        let result = ChangeOutcome {
            edit,
            status = if unclaimed_undo {
                ChangeStatus.UndoNotStarted
            } else {
                ChangeStatus.RollbackNotStarted
            },
            completed = completed_steps(source),
            message = "Recovery stopped before claiming the journal; the recorded edit phase is unchanged."
        };
        record("recovery", "reconcile_changes", wire_change_outcome(result), pending.call);
        tool_finished(pending.name, pending.call, wire_change_outcome(result));
        return result;
    }
    if source.owner_call != pending.call || source.owner_name != pending.name {
        abort("journal does not own the pending request");
    }
    if !completed_phase(source.phase) {
        return ChangeOutcome {
            edit,
            status = ChangeStatus.RecoveryRequired,
            completed = completed_steps(source),
            message = "The journal is unfinished. Inspect the actual state, then explicitly roll back; no forward operation was replayed."
        };
    }
    let result = outcome(source, source.phase.final_status());
    record("recovery", "reconcile_changes", wire_change_outcome(result), pending.call);
    tool_finished(pending.name, pending.call, wire_change_outcome(result));
    return result;
}

public flow replace_file(change: FileChange) -> FileOutcome ![
    SessionContext.current,
    MutationFiles,
    ChangeJournal,
    MutationHistory,
    MutationOutput,
    Error<BudgetExceeded>
] {
    if read_text(change.path) != change.before {
        let call = record("tool_call", "replace_file", change, -1);
        let result = FileOutcome {
            path = change.path,
            status = ChangeStatus.OriginalChanged,
            edit = ""
        };
        tool_finished("replace_file", call, wire_file_outcome(result));
        return result;
    }
    let result = apply_plan(
        "replace_file",
        [Change {
            operation = FileChangeOperation.Write,
            path = change.path,
            target = "",
            text = change.after
        }]
    );
    return FileOutcome {
        path = change.path,
        status = result.status,
        edit = result.edit
    };
}

public flow mutations_service_execute(request: ChangeCommand) -> ChangeOutcome {
    return match request {
        ChangeCommand.Apply(name, changes) => apply_plan(name, changes),
        ChangeCommand.Undo(edit) => undo_changes(edit),
        ChangeCommand.Rollback(edit) => rollback_changes(edit),
        ChangeCommand.Reconcile(edit) => reconcile_changes(edit)
    };
}

public flow mutations_service_list(observing: bool) -> Array<FileJournal> {
    return if observing {
        list_changes()
    } else {
        journals()
    };
}
