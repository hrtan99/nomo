module nomo.native.entry;

import std.io.{println, print, read_line};
import std.text.{trim, strip_prefix};
import nomo.native.agent.NativeCoding;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.core.json.encode;
import nomo.native.options.parse;
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, Session, reserve_generation, rename};
import nomo.native.context.{RollingContext, ContextProjection, compact};
import nomo.native.transfer.{save_archive, load_archive};

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
            println("Ask about the project; native tools provide directory listing, metadata, literal search, file reads, approved editing and Git operations.");
            println("/new [TITLE], /sessions, /resume ID, /rename TITLE, /history, /export FILE, /import FILE, /compact, /status, /quit");
            continue;
        }
        if request == "/history" {
            for item in archive.messages(selected.id, 0) limit Iterations(2147483647) {
                println("[" + item.role + "/" + item.name + " #" + item.id + "] " + item.text);
            }
            continue;
        }
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
