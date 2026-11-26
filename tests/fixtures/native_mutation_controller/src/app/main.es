module app.main;

import std.io.{println, IOError};
import std.text.{from_i64, ends_with};
import std.json.JsonValue;
import nomo.application.conversation.session_context.SessionContext;
import nomo.adapters.storage.conversations.{NativeHistory, record as save_record, tool_finished, pending_request, result_published};
import nomo.application.conversation.ports.{ConversationReader, ConversationCatalog};
import nomo.application.mutations.ports.{MutationFiles, ChangeJournal, MutationHistory, MutationOutput};
import nomo.application.mutations.service.{apply_plan, undo_changes, rollback_changes};
import nomo.domain.mutations.models.{Change, ChangeOutcome, Journal, Step};

type FileState = { exists: bool, text: string };
alias Schema = MemoryRegion<{ Journals: Store<string, Journal>, Steps: Store<string, Step>, Files: Store<string, FileState>, Flags: Store<string, bool> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-mutation-controller-fixture-v1", store = "mutation-controller-fixture");

flow file(path: string) -> FileState {
    return match Data.Files.get(path) { Some(value) => value, None() => FileState { exists = false, text = "" } };
}
flow journal(id: string) -> Journal {
    return match Data.Journals.get(id) { Some(value) => value, None() => { abort("fixture journal missing"); } };
}
flow step(key: string) -> Step {
    return match Data.Steps.get(key) { Some(value) => value, None() => { abort("fixture step missing"); } };
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
    return handle {
        if mode == "apply" { apply_plan("write_file", [Change { operation = "write", path = "note.txt", target = "", text = "before new\n" }]) }
        else { if mode == "undo" { undo_changes(edit) } else { rollback_changes(edit) } }
    } with {
        SessionContext.current() => { resume session; }
        MutationFiles.normalize(path) => { resume path; }
        MutationFiles.exists(path) => { resume file(path).exists; }
        MutationFiles.read(path) => { resume file(path).text; }
        MutationFiles.replace(path, text) => {
            let pending = match pending_request(session) { Some(value) => value, None() => { abort("write had no pending owner"); } };
            let id = session + "-" + from_i64(pending.call);
            let current = journal(id); let saved = step(id + "/0");
            if current.phase != "applying" || saved.phase != "applying" || saved.paths.len() != 1 {
                abort("write preceded durable applying state");
            }
            if !file(saved.paths[0].before).exists || file(saved.paths[0].before).text != "before old\n" { abort("write preceded its before snapshot"); }
            println("PORT write after durable recovery metadata");
            Data.Files.put(path, FileState { exists = true, text = text });
            resume;
        }
        MutationFiles.command(program, arguments, call) => { resume command(program, arguments); }
        ChangeJournal.lookup(id) => { resume Data.Journals.get(id); }
        ChangeJournal.insert(value) => { Data.Journals.insert(value.id, value); resume; }
        ChangeJournal.save(value) => { Data.Journals.put(value.id, value); resume; }
        ChangeJournal.step(key) => { resume Data.Steps.get(key); }
        ChangeJournal.save_step(key, value) => { Data.Steps.put(key, value); resume; }
        ChangeJournal.list(selected) => {
            let page = Data.Journals.page(None(), 100);
            var result: Array<Journal> = [];
            @limits([Iterations(100)]) for item in page.entries   { if item.value.session == selected { result = result.push(item.value); } }
            resume result;
        }
        MutationHistory.record(role, name, value, call) => {
            let saved = handle { save_record(role, name, value, call) } with { SessionContext.current() => { resume session; } };
            resume saved;
        }
        MutationHistory.finish(name, call, value) => {
            handle { tool_finished(name, call, value) } with { SessionContext.current() => { resume session; } };
            resume;
        }
        MutationHistory.session(id) => { resume history.load(id); }
        MutationHistory.pending(id) => { resume pending_request(id); }
        MutationHistory.message(id, index) => { resume history.message(id, index); }
        MutationHistory.published(id, call, name) => { resume result_published(id, call, name); }
        MutationOutput.write(line) => { println(line); resume; }
    };
}

public flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
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
