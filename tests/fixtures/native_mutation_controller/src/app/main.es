module app.main;

import std.io.println;
import std.io.IOError;
import std.text.from_i64;
import std.text.ends_with;
import std.text.starts_with;
import std.json.JsonValue;
import nomo.application.scope.SessionContext;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.conversations.record as save_record;
import nomo.adapters.storage.conversations.tool_finished;
import nomo.adapters.storage.conversations.pending_request;
import nomo.adapters.storage.conversations.result_published;
import nomo.adapters.storage.journals.NativeChangeJournals;
import nomo.application.conversation.ports.ConversationReader;
import nomo.application.conversation.ports.ConversationCatalog;
import nomo.application.editing.ports.MutationFiles;
import nomo.application.editing.ports.ChangeJournal;
import nomo.application.editing.ports.MutationHistory;
import nomo.application.editing.ports.MutationOutput;
import nomo.application.editing.ports.ChangeJournalStore;
import nomo.application.editing.changes.apply_plan;
import nomo.application.editing.changes.undo_changes;
import nomo.application.editing.changes.rollback_changes;
import nomo.domain.changes.Change;
import nomo.domain.changes.ChangeOutcome;
import nomo.domain.changes.Journal;
import nomo.domain.changes.Step;

type FileState = { exists: bool, text: string };
alias Schema = MemoryRegion<{ Files: Store<string, FileState>, Flags: Store<string, bool> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-mutation-controller-fixture-v1", store = "mutation-controller-fixture");

flow file(path: string) -> FileState {
    return match Data.Files.get(path) { Some(value) => value, None() => FileState { exists = false, text = "" } };
}
flow journal(id: string) -> Journal {
    return match (NativeChangeJournals {}).lookup(id) { Some(value) => value, None() => abort("fixture journal missing"), };
}
flow step(key: string) -> Step {
    return match (NativeChangeJournals {}).step(key) { Some(value) => value, None() => abort("fixture step missing"), };
}
flow command(program: string, arguments: Array<string>) -> bool {
    if program == "/bin/mkdir" { return true; }
    if program == "/bin/cp" {
        let source = arguments[2]; let destination = arguments[3];
        let fail = match Data.Flags.get("after") { Some(value) => value, None() => false };
        if fail && ends_with(destination, ".after") {
            Data.Flags.put("after", false);
            println("PORT after-write snapshot failed");
            return false;
        }
        let saved = file(source);
        if !saved.exists { abort("fixture copy source missing"); }
        Data.Files.put(destination, saved);
        return true;
    }
    if program == "/bin/rm" { Data.Files.put(arguments[2], FileState { exists = false, text = "" }); return true; }
    if program == "/usr/bin/diff" { return file(arguments[3]) == file(arguments[4]); }
    abort("unexpected fixture command");
}

flow execute(history: NativeHistory, session: string, mode: string, edit: string) -> ChangeOutcome {
    let journals = NativeChangeJournals {};
    return handle if mode == "apply" { apply_plan("write_file", [Change { operation = "write", path = "note.txt", target = "", text = "before new\n" }]) }
        else { if mode == "undo" { undo_changes(edit) } else { rollback_changes(edit) } } with {
        SessionContext.current() => session;
        MutationFiles.backup(id) => "/fixture-snapshots/" + id;
        MutationFiles.normalize(path) => path;
        MutationFiles.exists(path) => file(path).exists;
        MutationFiles.read(path) => file(path).text;
        MutationFiles.replace(path, text) => {
            let pending = match pending_request(session) { Some(value) => value, None() => abort("write had no pending owner"), };
            let id = session + "-" + from_i64(pending.call);
            let current = journal(id); let saved = step(id + "/0");
            if !starts_with(saved.paths[0].before, "/fixture-snapshots/") { abort("snapshot location ignored the supplied file port"); }
            if current.phase != "applying" || saved.phase != "applying" || saved.paths.len() != 1 {
                abort("write preceded durable applying state");
            }
            if !file(saved.paths[0].before).exists || file(saved.paths[0].before).text != "before old\n" { abort("write preceded its before snapshot"); }
            println("PORT write after durable recovery metadata");
            Data.Files.put(path, FileState { exists = true, text = text });
            ()
        }
        MutationFiles.command(program, arguments, call) => command(program, arguments);
        ChangeJournal.lookup(id) => journals.lookup(id);
        ChangeJournal.insert(value) => journals.insert(value);
        ChangeJournal.save(value) => journals.save(value);
        ChangeJournal.step(key) => journals.step(key);
        ChangeJournal.save_step(key, value) => journals.save_step(key, value);
        ChangeJournal.list(selected) => journals.list(selected);
        MutationHistory.record(role, name, value, call) => handle save_record(role, name, value, call) with { SessionContext.current() => session; };
        MutationHistory.finish(name, call, value) => handle tool_finished(name, call, value) with { SessionContext.current() => session; };
        MutationHistory.session(id) => history.load(id);
        MutationHistory.pending(id) => pending_request(id);
        MutationHistory.message(id, index) => history.message(id, index);
        MutationHistory.published(id, call, name) => result_published(id, call, name);
        MutationOutput.write(line) => println(line);
    };
}

public flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] {
    let history = NativeHistory {}; let session = history.create("mutation-controller", "Controlled mutation recovery");
    Data.Files.put("note.txt", FileState { exists = true, text = "before old\n" });
    let applied = execute(history, session.id, "apply", "");
    if applied.status != "applied" || applied.completed != 1 || file("note.txt").text != "before new\n" || history.load(session.id).pending != "" { abort("apply outcome changed"); }
    let undone = execute(history, session.id, "undo", applied.edit);
    if undone.status != "undone" || journal(applied.edit).phase != "undone" || file("note.txt").text != "before old\n" || history.load(session.id).pending != "" { abort("undo outcome changed"); }
    println("PASS controlled apply and undo");
    Data.Flags.put("after", true);
    let partial = execute(history, session.id, "apply", "");
    if partial.status != "recovery_required" || partial.completed != 0 || journal(partial.edit).phase != "failed" || file("note.txt").text != "before new\n" || history.load(session.id).pending == "" { abort("post-write failure was hidden"); }
    println("PORT partial write retained");
    let rolled_back = execute(history, session.id, "rollback", partial.edit);
    if rolled_back.status != "rolled_back" || journal(partial.edit).phase != "rolled_back" || file("note.txt").text != "before old\n" || history.load(session.id).pending != "" { abort("explicit rollback outcome changed"); }
    if history.load(session.id).ledger.tools != 3 { abort("rollback admitted a fresh forward operation"); }
    println("PASS controlled explicit rollback after write");
    return 0;
}
