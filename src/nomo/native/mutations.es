module nomo.native.mutations;

import std.fs.{path, relative_name, list, atomic_replace, WorkspacePath, ReadLimitError, IOError as FileError};
import std.codec.text.utf8_encode;
import std.io.{println, IOError as ConsoleError};
import std.text.{split, rsplit_once, from_i64, from_usize, count, replace_n};
import std.memory.MemoryCursor;
import std.effects.Fs;
import nomo.core.json.encode;
import nomo.native.workspace.{ProjectRoot, execute_step};
import nomo.native.file_io.read_text;
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, record, tool_finished, observe_started, observe_finished};

/// create/write/edit/mkdir/delete/move. edit uses target as a unique literal;
/// move uses target as the destination. Unused target/text fields are empty.
public type Change = { operation: string, path: string, target: string, text: string };
public type ChangeOutcome = { edit: string, status: string, completed: i64, message: string };
public type Journal = { id: string, session: string, name: string, call: i64, phase: string, steps: i64, message: string, owner_call: i64, owner_name: string };
type SavedPath = { path: string, before_exists: bool, before: string, after_exists: bool, after: string };
type Step = { phase: string, paths: Array<SavedPath> };
type FilePreview = { path: string, before: string, after: string };

alias Schema = MemoryRegion<{ Journals: Store<string, Journal>, Steps: Store<string, Step> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-file-journals-v1", store = "native-file-journals");

flow text<T>(value: T) -> string {
    return match encode(value, "change conversion failed", "change encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
}

flow checked(name: string) -> string {
    let target = match path<ProjectRoot>(name) {
        Ok(value) => value, Err(_) => { abort("invalid project path"); }
    };
    let normalized = relative_name(target);
    if normalized == "" || normalized == "." { abort("file changes require a path below the project root"); }
    return normalized;
}

flow location(name: string) -> WorkspacePath<ProjectRoot> {
    return match path<ProjectRoot>(name) { Ok(value) => value, Err(_) => { abort("invalid project path"); } };
}

flow parent(name: string) -> string {
    return match rsplit_once(name, "/") { Some((directory, _)) => directory, None() => "." };
}

// Membership in an existing parent distinguishes absence from a failed stat.
// Filesystem errors propagate; they are not interpreted as a missing file.
flow exists(name: string) -> bool {
    for item in list(location(parent(name))) limit Iterations(2147483647) {
        if relative_name(item) == name { return true; }
    }
    return false;
}

flow journal(id: string) -> Journal {
    let value = match Data.Journals.get(id) { Some(value) => value, None() => { abort("native edit journal not found"); } };
    let session = perform SessionContext.current();
    if value.session != session { abort("edit belongs to a different conversation"); }
    return value;
}

flow update(value: Journal, phase: string, steps: i64, message: string) -> Journal {
    let result = Journal { id = value.id, session = value.session, name = value.name, call = value.call,
        phase = phase, steps = steps, message = message, owner_call = value.owner_call, owner_name = value.owner_name };
    Data.Journals.put(value.id, result);
    return result;
}

flow command(program: string, arguments: Array<string>, call: i64) -> bool {
    return execute_step(program, arguments, call).exit_code == 0;
}

flow backup_root(value: Journal) -> string { return "/native-state/edits/" + value.id; }
flow step_key(id: string, index: i64) -> string { return id + "/" + from_i64(index); }

flow save_before(value: Journal, index: i64, name: string, slot: usize) -> Option<SavedPath> {
    let saved = backup_root(value) + "/" + from_i64(index) + "-" + from_usize(slot);
    let present = exists(name);
    if present && !command("/bin/cp", ["-a", "--", name, saved + ".before"], value.call) { return None(); }
    return Some(SavedPath { path = name, before_exists = present, before = saved + ".before",
        after_exists = false, after = saved + ".after" });
}

flow apply_step(id: string, change: Change) -> bool {
    let value = journal(id);
    let name = checked(change.path);
    if change.operation == "create" && exists(name) { update(value, "failed", value.steps, "create target already exists"); return false; }
    if (change.operation == "delete" || change.operation == "move" || change.operation == "edit") && !exists(name) {
        update(value, "failed", value.steps, "change source does not exist"); return false;
    }
    let target = if change.operation == "move" { checked(change.target) } else { "" };
    if change.operation == "move" && exists(target) { update(value, "failed", value.steps, "move destination already exists"); return false; }
    let index = value.steps;
    let key = step_key(id, index);
    var paths: Array<SavedPath> = [];
    let before = match save_before(value, index, name, 0) {
        Some(value) => value, None() => { update(value, "failed", index, "before snapshot failed; project mutation not dispatched"); return false; }
    };
    paths = paths.push(before);
    if change.operation == "move" {
        let destination = match save_before(value, index, target, 1) {
            Some(value) => value, None() => { update(value, "failed", index, "destination snapshot failed"); return false; }
        };
        paths = paths.push(destination);
    }
    // Publish the recovery material before a project mutation can start.
    Data.Steps.put(key, Step { phase = "prepared", paths = paths });
    let active = update(value, "applying", index + 1, "");
    record("edit_step", "prepared", change, value.call);
    println("[CHANGE ] " + text(change));
    var applied = false;
    if change.operation == "write" || change.operation == "create" || change.operation == "edit" {
        let original = if before.before_exists { read_text(name) } else { "" };
        var after = change.text;
        if change.operation == "edit" {
            if change.target == "" || count(original, change.target) != 1 { update(active, "failed", active.steps, "edit target must occur once"); return false; }
            after = replace_n(original, change.target, change.text, 1);
        }
        let preview = FilePreview { path = name, before = original, after = after };
        record("edit_preview", "file", preview, value.call);
        println("[PREVIEW] " + text(preview));
        Data.Steps.put(key, Step { phase = "applying", paths = paths });
        atomic_replace(location(name), utf8_encode(after));
        applied = true;
    }
    else if change.operation == "mkdir" { Data.Steps.put(key, Step { phase = "applying", paths = paths }); applied = command("/bin/mkdir", ["-p", "--", name], value.call); }
    else if change.operation == "delete" { Data.Steps.put(key, Step { phase = "applying", paths = paths }); applied = command("/bin/rm", ["-rf", "--", name], value.call); }
    else if change.operation == "move" { Data.Steps.put(key, Step { phase = "applying", paths = paths }); applied = command("/bin/mv", ["-T", "--no-clobber", "--", name, target], value.call); }
    else { update(active, "failed", active.steps, "unknown file operation"); return false; }
    if !applied { update(active, "failed", active.steps, "native project operation failed; inspect or roll back this journal"); return false; }
    if change.operation == "move" && exists(name) { update(active, "failed", active.steps, "move did not remove the source; inspect retained state"); return false; }
    var published: Array<SavedPath> = [];
    for item in paths limit Iterations(2147483647) {
        let present = exists(item.path);
        if present && !command("/bin/cp", ["-a", "--", item.path, item.after], value.call) {
            update(active, "failed", active.steps, "after snapshot failed; project mutation may already be complete"); return false;
        }
        published = published.push(SavedPath { path = item.path, before_exists = item.before_exists,
            before = item.before, after_exists = present, after = item.after });
    }
    Data.Steps.put(key, Step { phase = "applied", paths = published });
    record("edit_step_result", "applied", change, value.call);
    return true;
}

flow parents(id: string, name: string) -> bool {
    var prefix = "";
    for component in split(parent(name), "/") limit Iterations(2147483647) {
        if component != "." && component != "" {
            prefix = if prefix == "" { component } else { prefix + "/" + component };
            if !exists(prefix) && !apply_step(id, Change { operation = "mkdir", path = prefix, target = "", text = "" }) { return false; }
        }
    }
    return true;
}

flow outcome(value: Journal, status: string) -> ChangeOutcome {
    var completed: i64 = 0;
    var index: i64 = 0;
    while index < value.steps limit Iterations(2147483647) {
        match Data.Steps.get(step_key(value.id, index)) { Some(step) => { if step.phase == "applied" { completed = completed + 1; } } None() => {} }
        index = index + 1;
    }
    return ChangeOutcome { edit = value.id, status = status, completed = completed, message = value.message };
}

public flow apply_plan(name: string, changes: Array<Change>) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    let session = perform SessionContext.current();
    let call = record("tool_call", name, changes, -1);
    let id = session + "-" + from_i64(call);
    let value = Journal { id = id, session = session, name = name, call = call, phase = "preparing", steps = 0, message = "", owner_call = call, owner_name = name };
    Data.Journals.insert(id, value);
    println("[BATCH  ] " + text(changes));
    if !command("/bin/mkdir", ["-p", "--", backup_root(value)], call) {
        let failed = update(value, "failed", 0, "backup directory creation failed; project mutations not dispatched");
        let result = outcome(failed, "recovery_required"); record("partial_result", name, result, call); return result;
    }
    for change in changes limit Iterations(2147483647) {
        let normalized = checked(change.path);
        if change.operation == "create" || change.operation == "write" || change.operation == "mkdir" {
            if !parents(id, normalized) { let result = outcome(journal(id), "recovery_required"); record("partial_result", name, result, call); return result; }
        }
        if change.operation == "move" && !parents(id, checked(change.target)) {
            let result = outcome(journal(id), "recovery_required"); record("partial_result", name, result, call); return result;
        }
        if !apply_step(id, change) { let result = outcome(journal(id), "recovery_required"); record("partial_result", name, result, call); return result; }
    }
    let latest = journal(id);
    let complete = update(latest, "applied", latest.steps, "");
    let result = outcome(complete, "applied");
    tool_finished(name, call, result);
    return result;
}

/// Apply related create/write/edit/mkdir/delete/move operations. Every actual native mutation has its own Host approval. Returns a durable edit ID for undo/recovery.
public tool apply_changes(changes: Array<Change>) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return apply_plan("apply_changes", changes);
}

/// Create a UTF-8 file, including missing parent directories. Existing targets are refused.
public tool create_file(pathname: string, content: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return apply_plan("create_file", [Change { operation = "create", path = pathname, target = "", text = content }]);
}

/// Write a UTF-8 file, retaining its previous state for undo.
public tool write_file(pathname: string, content: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return apply_plan("write_file", [Change { operation = "write", path = pathname, target = "", text = content }]);
}

/// Create a project directory and missing parents.
public tool make_directory(pathname: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return apply_plan("make_directory", [Change { operation = "mkdir", path = pathname, target = "", text = "" }]);
}

/// Delete a project file or directory after snapshotting it for undo.
public tool delete_path(pathname: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return apply_plan("delete_path", [Change { operation = "delete", path = pathname, target = "", text = "" }]);
}

/// Move a project file or directory to an absent destination, retaining snapshots for undo.
public tool move_path(source: string, destination: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return apply_plan("move_path", [Change { operation = "move", path = source, target = destination, text = "" }]);
}

public flow journals() -> Array<Journal> {
    let session = perform SessionContext.current();
    var result: Array<Journal> = [];
    var cursor: Option<MemoryCursor> = None();
    while true limit Iterations(2147483647) {
        let page = Data.Journals.page(cursor, 100);
        for item in page.entries limit Iterations(2147483647) { if item.value.session == session { result = result.push(item.value); } }
        match page.cursor { Some(next) => { cursor = Some(next); } None() => { break; } }
    }
    return result;
}

flow selected_edit(id: string) -> Journal {
    if id != "" { return journal(id); }
    var selected: Option<Journal> = None();
    for item in journals() limit Iterations(2147483647) {
        if item.phase == "applied" { match selected {
            Some(previous) => { if item.call > previous.call { selected = Some(item); } }
            None() => { selected = Some(item); }
        } }
    }
    return match selected { Some(value) => value, None() => { abort("no applied native edit to undo"); } };
}

flow restore(value: Journal, call: i64, checking: bool) -> bool {
    var index = value.steps - 1;
    while index >= 0 limit Iterations(2147483647) {
        let key = step_key(value.id, index);
        let step = match Data.Steps.get(key) { Some(value) => value, None() => { abort("native edit step missing"); } };
        if step.phase == "applying" || step.phase == "applied" || step.phase == "restoring" {
            for item in step.paths limit Iterations(2147483647) {
                let present = exists(item.path);
                if checking {
                    if present != item.after_exists { return false; }
                    if present && !command("/usr/bin/diff", ["-r", "--no-dereference", "--", item.path, item.after], call) { return false; }
                }
            }
            Data.Steps.put(key, Step { phase = "restoring", paths = step.paths });
            for item in step.paths limit Iterations(2147483647) {
                println("[RESTORE] " + text(item));
                if exists(item.path) && !command("/bin/rm", ["-rf", "--", item.path], call) { return false; }
                if item.before_exists && !command("/bin/cp", ["-a", "--", item.before, item.path], call) { return false; }
            }
            Data.Steps.put(key, Step { phase = "restored", paths = step.paths });
            record("edit_step_result", "restored", key, call);
        }
        index = index - 1;
    }
    return true;
}

/// Undo the selected journal (empty edit selects the latest applied journal). Current contents must match its saved result. Native Host approval applies to every restoration operation.
public tool undo_changes(edit: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ConsoleError>] {
    let source = selected_edit(edit);
    if source.phase != "applied" { abort("only an applied edit can start undo; use rollback_changes for interrupted edits"); }
    let call = record("tool_call", "undo_changes", source.id, -1);
    let active = Journal { id = source.id, session = source.session, name = source.name, call = source.call,
        phase = "undoing", steps = source.steps, message = "", owner_call = call, owner_name = "undo_changes" };
    Data.Journals.put(source.id, active);
    if !restore(active, call, true) {
        let failed = update(active, "undoing", active.steps, "undo stopped; current content may have changed or a restoration failed");
        let result = outcome(failed, "recovery_required"); record("partial_result", "undo_changes", result, call); return result;
    }
    let complete = update(active, "undone", active.steps, "");
    let result = outcome(complete, "undone");
    tool_finished("undo_changes", call, result);
    return result;
}

/// Explicitly restore an interrupted/partial transaction from its durable before snapshots, after reviewing actual state. This never replays the requested forward changes.
public tool rollback_changes(edit: string) -> ChangeOutcome
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ConsoleError>] {
    let source = journal(edit);
    if source.phase == "applied" || source.phase == "undone" || source.phase == "rolled_back" { abort("journal has no interrupted change to roll back"); }
    let history = NativeHistory {};
    let session = history.load(source.session);
    let call = source.owner_call;
    let name = source.owner_name;
    let binding = source.session + ":" + from_i64(call) + " " + name;
    if session.pending != binding { abort("rollback does not match the selected conversation's pending operation"); }
    record("recovery", "rollback_changes", source.id, call);
    if !restore(source, call, false) {
        let result = outcome(journal(edit), "recovery_required"); record("partial_result", "rollback_changes", result, call); return result;
    }
    let complete = update(source, "rolled_back", source.steps, "");
    let result = outcome(complete, "rolled_back");
    record("recovery_result", "rollback_changes", result, call);
    tool_finished(name, call, result);
    return result;
}

/// Inspect this conversation's durable edit phases, including an interrupted edit, without starting another mutation.
public tool list_changes() -> Array<Journal>
    ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] {
    let call = observe_started("list_changes", "");
    let result = journals();
    observe_finished("list_changes", call, result);
    return result;
}
