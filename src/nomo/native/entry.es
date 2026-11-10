module nomo.native.entry;

import std.io.{println, print, read_line};
import std.text.{trim, strip_prefix, contains, parse_i64, from_i64, from_i32};
import nomo.native.agent.NativeCoding;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.core.json.encode;
import nomo.native.options.parse;
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, Session, reserve_generation, rename, message, fork};
import nomo.native.context.{RollingContext, ContextProjection, compact};
import nomo.native.transfer.{save_archive, load_archive};
import nomo.native.mutations.{journals, undo_changes, rollback_changes, reconcile_changes};
import nomo.native.files.read_file;
import nomo.native.navigation.{find_files, search_project};

flow navigation_command(session: string, operation: string, argument: string) -> unit {
    let result = handle {
        match operation {
            "tree" => find_files(argument, "", 3),
            "glob" => find_files(".", argument, 0),
            _ => search_project(".", argument, true)
        }
    } with { SessionContext.current() => { resume session; } };
    println(result.stdout);
    if result.stderr != "" { println(result.stderr); }
    if result.exit_code > 1 { println("[ERROR  ] Project discovery exited " + from_i32(result.exit_code)); }
}

flow show(value: Session) -> unit {
    println("[SESSION] " + value.id + " · " + value.title);
    if value.pending != "" {
        println("[PENDING] " + value.pending + " has no recorded completion. Inspect actual state; it is not automatically replayed.");
    }
}

flow ask(session: string, request: string) -> unit {
    let archive = NativeHistory {};
    archive.append(session, "user", "", request, -1);
    let projection = RollingContext {};
    var input = projection.build(session, request);
    if projection.needs_compaction(input) {
        println("[CONTEXT] Summarizing; complete original history stays saved.");
        compact(session);
        input = projection.build(session, request);
    }
    reserve_generation(session, false, projection.bytes(input));
    let answer = handle { NativeCoding.run(input) } with {
        SessionContext.current() => { resume session; }
    };
    archive.append(session, "assistant", "", answer.text, -1);
    println(answer.text);
}

flow show_history(session: string, query: string, first: i64, count: i64) -> unit {
    let archive = NativeHistory {};
    let selected = archive.load(session);
    var index = first;
    var shown: i64 = 0;
    while index < selected.next_event && (count < 0 || shown < count) limit Iterations(2147483647) {
        let item = message(session, index);
        if query == "" || contains(item.text, query) || contains(item.name, query) {
            println("[" + item.role + "/" + item.name + " #" + item.id + "] " + item.text);
            shown = shown + 1;
        }
        index = index + 1;
    }
    if index < selected.next_event { println("[HISTORY] More events remain; /page " + from_i64(index)); }
}

flow edit_command(session: string, operation: string, id: string) -> unit {
    handle {
        if operation == "read" {
            let result = read_file(id);
            let json = match encode(result, "file conversion failed", "file encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
            println("[FILE   ] " + json);
        }
        else if operation == "list" {
            for item in journals() limit Iterations(2147483647) {
                let json = match encode(item, "edit conversion failed", "edit encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                println("[EDIT   ] " + json);
            }
        }
        else {
            let result = match operation { "undo" => undo_changes(id), "reconcile" => reconcile_changes(id), _ => rollback_changes(id) };
            let json = match encode(result, "edit result conversion failed", "edit result encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
            println("[EDIT   ] " + json);
        }
    } with { SessionContext.current() => { resume session; } };
}

flow event_index(raw: string) -> i64 {
    return match parse_i64(trim(raw)) {
        Ok(value) => { if value < 0 { abort("event index must be nonnegative"); } value },
        Err(_) => { abort("expected an event index"); }
    };
}

public flow run(args: Array<string>) -> i32
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
    let options = parse(args);
    let archive = NativeHistory {};
    var selected = match options.resume_id {
        "" => {
            if options.fresh { archive.create(options.workspace, "New conversation") }
            else { match archive.selected(options.workspace) {
                Some(id) => archive.select(options.workspace, id),
                None() => archive.create(options.workspace, "New conversation")
            } }
        }
        id => archive.select(options.workspace, id)
    };
    show(selected);
    match options.once { Some(request) => { ask(selected.id, request); return 0; } None() => {} }
    println("[NATIVE ] Nomo native chat · /help · /quit");
    while true limit Iterations(2147483647) {
        print("nomo> ");
        let raw = read_line();
        if raw == "" { return 0; }
        let request = trim(raw);
        if request == "/quit" || request == "/exit" { return 0; }
        if request == "" { continue; }
        if request == "/help" {
            println("Ask about the project; native tools provide recursive/glob discovery, literal/regex search, file reads, approved editing and Git operations.");
            println("/new [TITLE], /sessions, /resume ID, /rename TITLE, /history [TEXT], /page EVENT, /fork [EVENT], /export FILE, /import FILE, /compact, /status, /tree [PATH], /glob PATTERN, /search REGEX, /read FILE, /edits, /undo [EDIT], /rollback EDIT, /recover EDIT, /quit");
            continue;
        }
        if request == "/tree" { navigation_command(selected.id, "tree", "."); continue; }
        match strip_prefix(request, "/tree ") { Some(pathname) => { navigation_command(selected.id, "tree", trim(pathname)); continue; } None() => {} }
        match strip_prefix(request, "/glob ") { Some(pattern) => { navigation_command(selected.id, "glob", trim(pattern)); continue; } None() => {} }
        match strip_prefix(request, "/search ") { Some(pattern) => { navigation_command(selected.id, "search", trim(pattern)); continue; } None() => {} }
        if request == "/history" || request == "/events" { show_history(selected.id, "", 0, -1); continue; }
        match strip_prefix(request, "/history ") {
            Some(query) => { show_history(selected.id, trim(query), 0, -1); continue; } None() => {}
        }
        match strip_prefix(request, "/page ") {
            Some(start) => { show_history(selected.id, "", event_index(start), 50); continue; } None() => {}
        }
        if request == "/fork" { selected = fork(selected.id, archive.load(selected.id).next_event - 1); show(selected); continue; }
        match strip_prefix(request, "/fork ") {
            Some(index) => { selected = fork(selected.id, event_index(index)); show(selected); continue; } None() => {}
        }
        match strip_prefix(request, "/read ") { Some(pathname) => { edit_command(selected.id, "read", trim(pathname)); continue; } None() => {} }
        match strip_prefix(request, "/recover ") { Some(id) => { edit_command(selected.id, "reconcile", trim(id)); continue; } None() => {} }
        if request == "/edits" { edit_command(selected.id, "list", ""); continue; }
        if request == "/undo" { edit_command(selected.id, "undo", ""); continue; }
        match strip_prefix(request, "/undo ") { Some(id) => { edit_command(selected.id, "undo", trim(id)); continue; } None() => {} }
        match strip_prefix(request, "/rollback ") { Some(id) => { edit_command(selected.id, "rollback", trim(id)); continue; } None() => {} }
        if request == "/sessions" {
            for item in archive.sessions(options.workspace) limit Iterations(2147483647) { show(item); }
            continue;
        }
        if request == "/new" { selected = archive.create(options.workspace, "New conversation"); show(selected); continue; }
        match strip_prefix(request, "/new ") {
            Some(title) => { selected = archive.create(options.workspace, trim(title)); show(selected); continue; } None() => {}
        }
        match strip_prefix(request, "/resume ") {
            Some(id) => { selected = archive.select(options.workspace, trim(id)); show(selected); continue; } None() => {}
        }
        match strip_prefix(request, "/rename ") {
            Some(title) => { rename(selected.id, trim(title)); selected = archive.load(selected.id); show(selected); continue; } None() => {}
        }
        match strip_prefix(request, "/export ") {
            Some(pathname) => { save_archive(selected.id, trim(pathname)); continue; } None() => {}
        }
        match strip_prefix(request, "/import ") {
            Some(pathname) => { selected = load_archive(options.workspace, trim(pathname)); show(selected); continue; } None() => {}
        }
        if request == "/compact" { compact(selected.id); println("[CONTEXT] Summary saved; full original events retained."); continue; }
        if request == "/status" {
            let status = match encode(archive.load(selected.id), "status conversion failed", "status encoding failed") {
                Ok(value) => value, Err(error) => { abort(error); }
            };
            println("[STATUS ] " + status);
            println("[BUDGET ] generation_allowance is configured allowance; context_bytes is an estimate, not measured token usage.");
            continue;
        }
        ask(selected.id, request);
    }
    return 0;
}
