module nomo.application.native.mutations.service;

import std.text.{split, from_i64, from_usize};
import std.json.{JsonValue, parse};
import std.agent.message.Message;
import nomo.core.json.encode;
import nomo.native.history.{SessionContext, PendingRequest};
import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.mutations.models.{Change, PlanRequest, ChangeOutcome, Journal, SavedPath, Step, FilePreview};
import nomo.domain.mutations.policy.{parent, below_root, requires_existing, creates_parents, content_change, restoring_phase, completed_phase, file_request, literal_after};
import nomo.application.native.mutations.ports.{MutationFiles, ChangeJournal, MutationHistory, MutationOutput};

flow text<T>(value: T) -> string {
    return match encode(value, "change conversion failed", "change encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
}

flow checked(name: string) -> string { return below_root(perform MutationFiles.normalize(name)); }
flow exists(name: string) -> bool { return perform MutationFiles.exists(name); }
flow read_text(name: string) -> string { return perform MutationFiles.read(name); }
flow println(line: string) -> unit { perform MutationOutput.write(line); }
flow as_json<T>(value: T) -> JsonValue {
    let result: Option<Message<JsonValue>> = Message.new(value).cast<JsonValue>();
    return match result { Some(value) => value.body, None() => { abort("history conversion failed"); } };
}
flow record<T>(role: string, name: string, value: T, call: i64) -> i64 { return perform MutationHistory.record(role, name, as_json(value), call); }
flow tool_finished<T>(name: string, call: i64, value: T) -> unit { perform MutationHistory.finish(name, call, as_json(value)); }
flow observe_started<T>(name: string, value: T) -> i64 { return record("observation_call", name, value, -1); }
flow observe_finished<T>(name: string, call: i64, value: T) -> unit { record("tool", name, value, call); }
flow pending_request(id: string) -> Option<PendingRequest> { return perform MutationHistory.pending(id); }
flow message(id: string, index: i64) -> ChatMessage { return perform MutationHistory.message(id, index); }
flow result_published(id: string, call: i64, name: string) -> bool { return perform MutationHistory.published(id, call, name); }

flow journal(id: string) -> Journal {
    let value = match perform ChangeJournal.lookup(id) { Some(value) => value, None() => { abort("native edit journal not found"); } };
    let session = perform SessionContext.current();
    if value.session != session { abort("edit belongs to a different conversation"); }
    return value;
}

flow update(value: Journal, phase: string, steps: i64, message: string) -> Journal {
    let result = Journal { id = value.id, session = value.session, name = value.name, call = value.call,
        phase = phase, steps = steps, message = message, owner_call = value.owner_call, owner_name = value.owner_name };
    perform ChangeJournal.save(result);
    return result;
}

flow command(program: string, arguments: Array<string>, call: i64) -> bool {
    return perform MutationFiles.command(program, arguments, call);
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
    if requires_existing(change.operation) && !exists(name) {
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
    perform ChangeJournal.save_step(key, Step { phase = "prepared", paths = paths });
    let active = update(value, "applying", index + 1, "");
    record("edit_step", "prepared", change, value.call);
    println("[CHANGE ] " + text(change));
    var applied = false;
    if content_change(change.operation) {
        let original = if before.before_exists { read_text(name) } else { "" };
        var after = change.text;
        if change.operation == "edit" {
            after = match literal_after(original, change.target, change.text) {
                Ok(value) => value, Err(error) => { update(active, "failed", active.steps, error); return false; }
            };
        }
        let preview = FilePreview { path = name, before = original, after = after };
        record("edit_preview", "file", preview, value.call);
        println("[PREVIEW] " + text(preview));
        perform ChangeJournal.save_step(key, Step { phase = "applying", paths = paths });
        perform MutationFiles.replace(name, after);
        applied = true;
    }
    else if change.operation == "mkdir" { perform ChangeJournal.save_step(key, Step { phase = "applying", paths = paths }); applied = command("/bin/mkdir", ["-p", "--", name], value.call); }
    else if change.operation == "delete" { perform ChangeJournal.save_step(key, Step { phase = "applying", paths = paths }); applied = command("/bin/rm", ["-rf", "--", name], value.call); }
    else if change.operation == "move" { perform ChangeJournal.save_step(key, Step { phase = "applying", paths = paths }); applied = command("/bin/mv", ["-T", "--no-clobber", "--", name, target], value.call); }
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
    perform ChangeJournal.save_step(key, Step { phase = "applied", paths = published });
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
        match perform ChangeJournal.step(step_key(value.id, index)) { Some(step) => { if step.phase == "applied" { completed = completed + 1; } } None() => {} }
        index = index + 1;
    }
    return ChangeOutcome { edit = value.id, status = status, completed = completed, message = value.message };
}

public flow apply_plan(name: string, changes: Array<Change>) -> ChangeOutcome ![SessionContext, MutationFiles, ChangeJournal, MutationHistory, MutationOutput] {
    let session = perform SessionContext.current();
    let call = record("tool_call", name, PlanRequest { format = "nomo-native-file-plan-1", changes = changes }, -1);
    let id = session + "-" + from_i64(call);
    let value = Journal { id = id, session = session, name = name, call = call, phase = "preparing", steps = 0, message = "", owner_call = call, owner_name = name };
    perform ChangeJournal.insert(value);
    println("[BATCH  ] " + text(changes));
    if !command("/bin/mkdir", ["-p", "--", backup_root(value)], call) {
        let failed = update(value, "failed", 0, "backup directory creation failed; project mutations not dispatched");
        let result = outcome(failed, "recovery_required"); record("partial_result", name, result, call); return result;
    }
    for change in changes limit Iterations(2147483647) {
        let normalized = checked(change.path);
        if creates_parents(change.operation) {
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

public flow journals() -> Array<Journal> ![SessionContext, ChangeJournal] {
    let session = perform SessionContext.current();
    return perform ChangeJournal.list(session);
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
        let step = match perform ChangeJournal.step(key) { Some(value) => value, None() => { abort("native edit step missing"); } };
        if restoring_phase(step.phase) {
            for item in step.paths limit Iterations(2147483647) {
                let present = exists(item.path);
                if checking {
                    if present != item.after_exists { return false; }
                    if present && !command("/usr/bin/diff", ["-r", "--no-dereference", "--", item.path, item.after], call) { return false; }
                }
            }
            perform ChangeJournal.save_step(key, Step { phase = "restoring", paths = step.paths });
            for item in step.paths limit Iterations(2147483647) {
                println("[RESTORE] " + text(item));
                if exists(item.path) && !command("/bin/rm", ["-rf", "--", item.path], call) { return false; }
                if item.before_exists && !command("/bin/cp", ["-a", "--", item.before, item.path], call) { return false; }
            }
            perform ChangeJournal.save_step(key, Step { phase = "restored", paths = step.paths });
            record("edit_step_result", "restored", key, call);
        }
        index = index - 1;
    }
    return true;
}

/// Undo the selected journal (empty edit selects the latest applied journal). Current contents must match its saved result. Native Host approval applies to every restoration operation.
public flow undo_changes(edit: string) -> ChangeOutcome ![SessionContext, MutationFiles, ChangeJournal, MutationHistory, MutationOutput] {
    let source = selected_edit(edit);
    if source.phase != "applied" { abort("only an applied edit can start undo; use rollback_changes for interrupted edits"); }
    let call = record("tool_call", "undo_changes", source.id, -1);
    let active = Journal { id = source.id, session = source.session, name = source.name, call = source.call,
        phase = "undoing", steps = source.steps, message = "", owner_call = call, owner_name = "undo_changes" };
    perform ChangeJournal.save(active);
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
public flow rollback_changes(edit: string) -> ChangeOutcome ![SessionContext, MutationFiles, ChangeJournal, MutationHistory, MutationOutput] {
    let source = journal(edit);
    if completed_phase(source.phase) { abort("journal has no interrupted change to roll back"); }
    let session = perform MutationHistory.session(source.session);
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
public flow list_changes() -> Array<Journal> ![SessionContext, ChangeJournal, MutationHistory] {
    let call = observe_started("list_changes", "");
    let result = journals();
    observe_finished("list_changes", call, result);
    return result;
}

/// Reconcile a completed journal/result after interruption without executing any project operation. Unfinished changes still require explicit rollback.
public flow reconcile_changes(edit: string) -> ChangeOutcome ![SessionContext, MutationFiles, ChangeJournal, MutationHistory, MutationOutput] {
    let session = perform SessionContext.current();
    let pending = match pending_request(session) {
        Some(value) => value,
        None() => { return ChangeOutcome { edit = edit, status = "no_pending_request", completed = 0, message = "No pending operation needs reconciliation." }; }
    };
    let source = match perform ChangeJournal.lookup(edit) {
        Some(value) => value,
        None() => {
            let expected = session + "-" + from_i64(pending.call);
            let is_file_request = file_request(pending.name);
            if edit != expected { abort("edit ID does not match the pending request"); }
            if result_published(session, pending.call, pending.name) {
                let result = ChangeOutcome { edit = edit, status = "recorded_result_retained", completed = 0, message = "The existing complete result was retained; no project operation was replayed." };
                record("recovery", "reconcile_changes", result, pending.call);
                tool_finished(pending.name, pending.call, result);
                return result;
            }
            var undispatched = !pending.complete;
            if pending.complete && is_file_request {
                let body = match parse(message(session, pending.call).text) { Ok(value) => value, Err(_) => { abort("pending request is not JSON"); } };
                let converted: Option<Message<PlanRequest>> = Message.new(body).cast<PlanRequest>();
                undispatched = match converted { Some(value) => value.body.format == "nomo-native-file-plan-1", None() => false };
            }
            if !undispatched {
                return ChangeOutcome { edit = edit, status = "recovery_required", completed = 0, message = "An older or unjournalled operation has no recorded outcome. Inspect actual state; execution is not inferred and the request remains pending." };
            }
            // Versioned file plans insert their journal before dispatch. Older
            // unversioned records do not establish this invariant.
            let result = ChangeOutcome { edit = edit, status = "not_dispatched", completed = 0, message = "Request preparation stopped before project dispatch; no operation was replayed." };
            record("recovery", "reconcile_changes", result, pending.call);
            tool_finished(pending.name, pending.call, result);
            return result;
        }
    };
    if source.session != session { abort("edit belongs to another conversation"); }
    if source.phase == "applied" && pending.name == "undo_changes" && pending.complete
        && message(session, pending.call).text == text(source.id) && source.owner_call != pending.call {
        let result = ChangeOutcome { edit = edit, status = "undo_not_started", completed = source.steps, message = "Undo stopped before claiming the journal; the recorded edit remains applied." };
        record("recovery", "reconcile_changes", result, pending.call);
        tool_finished(pending.name, pending.call, result);
        return result;
    }
    if source.owner_call != pending.call || source.owner_name != pending.name { abort("journal does not own the pending request"); }
    if !completed_phase(source.phase) {
        return ChangeOutcome { edit = edit, status = "recovery_required", completed = outcome(source, source.phase).completed,
            message = "The journal is unfinished. Inspect the actual state, then explicitly roll back; no forward operation was replayed." };
    }
    let result = outcome(source, source.phase);
    record("recovery", "reconcile_changes", result, pending.call);
    tool_finished(pending.name, pending.call, result);
    return result;
}
