module nomo.native.entry;

import std.io.{println, print, read_line};
import std.text.{trim, strip_prefix, split_once, contains, parse_i64, parse_usize, from_i64, from_i32};
import std.json.parse as parse_json;
import std.agent.message.Message;
import nomo.native.agent.NativeCoding;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.core.json.encode;
import nomo.native.options.parse;
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, Session, reserve_generation, rename, message, fork, copy_status, copy_jobs, copy_job, resume_fork, discard_copy};
import nomo.native.context.{RollingContext, ContextProjection, compact};
import nomo.native.transfer.{save_archive, load_archive, resume_import};
import nomo.native.mutations.{journals, undo_changes, rollback_changes, reconcile_changes};
import nomo.native.files.read_file;
import nomo.native.navigation.{find_files, search_project};
import nomo.native.lifecycle.{attempts, begin, dispatching, returned, complete_attempt, resolve};
import nomo.native.configuration.{Settings, SettingsContext, load as load_configuration, status as configuration_status, effective_window, as_number, estimated_tokens};
import nomo.native.terminal.check_project;
import nomo.native.terminal.run_command;
import nomo.native.processes.{start_job, read_job, write_job, close_job_input, stop_job, list_jobs, job_output};

type Argv = { program: string, arguments: Array<string> };
flow command_argv(raw: string) -> Argv {
    let parsed = match parse_json(raw) { Ok(value) => value, Err(_) => { abort("use a JSON argv array, for example [\"/usr/bin/git\",\"status\"]"); } };
    let decoded: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
    let values = match decoded { Some(value) => value.body, None() => { abort("command argv must be a JSON array of strings"); } };
    var program = "";
    var first = true;
    var arguments: Array<string> = [];
    for value in values limit Iterations(2147483647) {
        if first { program = value; first = false; } else { arguments = arguments.push(value); }
    }
    if program == "" { abort("provide a command program"); }
    return Argv { program = program, arguments = arguments };
}

flow process_json<T>(value: T) -> string {
    return match encode(value, "process conversion failed", "process encoding failed") { Ok(text) => text, Err(error) => { abort(error); } };
}

flow process_command(session: string, operation: string, argument: string) -> unit {
    handle {
        if operation == "jobs" {
            for value in list_jobs() limit Iterations(2147483647) {
                println("[JOB    ] " + process_json(value));
            }
        }
        else {
            var result = "";
            if operation == "exec" || operation == "spawn" {
                let argv = command_argv(argument);
                if operation == "exec" { result = process_json(run_command(argv.program, argv.arguments)); }
                else { result = process_json(start_job(argv.program, argv.arguments)); }
            }
            else if operation == "poll" {
                let (job, bytes) = match split_once(argument, " ") { Some(parts) => parts, None() => (argument, "65536") };
                let count = match parse_usize(trim(bytes)) { Ok(value) => value, Err(_) => { abort("expected a read byte count"); } };
                result = process_json(read_job(job, count));
            }
            else if operation == "send" {
                let (job, input) = match split_once(argument, " ") { Some(parts) => parts, None() => { abort("use /send JOB JSON_STRING"); } };
                let parsed = match parse_json(input) { Ok(value) => value, Err(_) => { abort("input must be a JSON string; use \\n for a newline"); } };
                let converted: Option<Message<string>> = Message.new(parsed).cast<string>();
                let text = match converted { Some(value) => value.body, None() => { abort("input must be a JSON string"); } };
                result = process_json(write_job(job, text));
            }
            else if operation == "close-input" { result = process_json(close_job_input(argument)); }
            else if operation == "stop" { result = process_json(stop_job(argument)); }
            else { result = process_json(job_output(argument)); }
            println("[JOB    ] " + result);
        }
    } with { SessionContext.current() => { resume session; } };
}

flow load_settings(session: string) -> Settings {
    return handle { load_configuration() } with { SessionContext.current() => { resume session; } };
}

flow generation_supported(settings: Settings) -> bool {
    if settings.max_output_tokens != 131072 {
        println("[CONFIG ] This native runtime has a static 131072 output cap. The requested max_output_tokens needs an upstream per-call limit API; no model request was submitted.");
        return false;
    }
    return true;
}

flow ready_for_turn(session: string) -> bool {
    for value in attempts(session, true) limit Iterations(2147483647) {
        if value.kind == "coding" || value.kind == "summary" {
            println("[RUN    ] " + value.id + " has no recorded completion. Inspect /runs; /resolve-run ID NOTE records your recovery decision. This prompt was not submitted.");
            return false;
        }
    }
    return true;
}

flow navigation_command(session: string, operation: string, argument: string) -> unit {
    let settings = load_settings(session);
    let result = handle {
        match operation {
            "tree" => find_files(argument, "", 3),
            "glob" => find_files(".", argument, 0),
            _ => search_project(".", argument, true)
        }
    } with { SessionContext.current() => { resume session; } SettingsContext.current() => { resume settings; } };
    println(result.stdout);
    if result.stderr != "" { println(result.stderr); }
    if result.exit_code > 1 { println("[ERROR  ] Project discovery exited " + from_i32(result.exit_code)); }
}

flow show(value: Session) -> unit {
    println("[SESSION] " + value.id + " · " + value.title);
    match copy_status(value.id) {
        Some(job) => { if job.phase != "ready" { println("[COPY   ] " + job.phase + "; /resume-copy " + job.id + " or /discard-copy " + job.id); } }
        None() => {}
    }
    if value.pending != "" {
        println("[PENDING] " + value.pending + " has no recorded completion. Inspect actual state; it is not automatically replayed.");
    }
    for attempt in attempts(value.id, true) limit Iterations(2147483647) {
        println("[RUN    ] " + attempt.id + " " + attempt.kind + " " + attempt.phase + "; no completion recorded. Inspect actual state, then /resolve-run ID [NOTE].");
    }
}

flow ask(session: string, request: string) -> bool {
    if !ready_for_turn(session) { return false; }
    let archive = NativeHistory {};
    let request_event = archive.append(session, "user", "", request, -1);
    let settings = load_settings(session);
    if !generation_supported(settings) { return false; }
    let projection = RollingContext {};
    var input = projection.build(session, request, settings);
    if projection.needs_compaction(input) {
        println("[CONTEXT] Summarizing; complete original history stays saved.");
        compact(session, settings);
        input = projection.build(session, request, settings);
    }
    if estimated_tokens(projection.bytes(input)) > as_number(effective_window(settings) - settings.max_output_tokens) {
        println("[CONTEXT] Saved summary and retained input still exceed the configured context estimate. No coding model request was submitted; complete original history remains saved.");
        return false;
    }
    reserve_generation(session, false, projection.bytes(input));
    let attempt = begin(session, "coding", "NativeCoding", request_event, archive.load(session).next_event - 1);
    dispatching(attempt.id);
    let answer = handle { NativeCoding.run(input) } with {
        SessionContext.current() => { resume session; }
        SettingsContext.current() => { resume settings; }
    };
    returned(attempt.id, "assistant", "", answer.text, request_event);
    complete_attempt(attempt.id);
    println(answer.text);
    return true;
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
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
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
    for job in copy_jobs(options.workspace) limit Iterations(2147483647) {
        if job.phase == "staging" || job.phase == "copying" {
            println("[COPY   ] Unfinished " + job.kind + " " + job.id + "; /resume-copy " + job.id + " or /discard-copy " + job.id);
        }
    }
    match options.once { Some(request) => { return if ask(selected.id, request) { 0 } else { 4 }; } None() => {} }
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
            println("Terminal: /exec JSON_ARGV, /spawn JSON_ARGV, /jobs, /poll JOB [MAX_BYTES], /send JOB JSON_STRING, /close-input JOB, /stop JOB, /job-output JOB. /poll waits for output or termination. Saved job phases are historical observations; current Host handles are not durable across process restart.");
            println("/new [TITLE], /sessions, /resume ID, /rename TITLE, /history [TEXT], /page EVENT, /fork [EVENT], /export FILE, /import FILE, /copies, /resume-copy ID, /discard-copy ID, /runs, /resolve-run ID [NOTE], /config, /check, /compact, /status, /tree [PATH], /glob PATTERN, /search REGEX, /read FILE, /edits, /undo [EDIT], /rollback EDIT, /recover EDIT, /quit");
            continue;
        }
        let (operation, argument) = match split_once(request, " ") { Some(parts) => parts, None() => (request, "") };
        if operation == "/exec" || operation == "/spawn" || operation == "/jobs" || operation == "/poll" || operation == "/send" || operation == "/close-input" || operation == "/stop" || operation == "/job-output" {
            let name = match strip_prefix(operation, "/") { Some(value) => value, None() => operation };
            process_command(selected.id, name, trim(argument));
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
        if request == "/copies" {
            for job in copy_jobs(options.workspace) limit Iterations(2147483647) {
                let json = match encode(job, "copy conversion failed", "copy encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                println("[COPY   ] " + json);
            }
            continue;
        }
        match strip_prefix(request, "/resume-copy ") {
            Some(id) => {
                let job = copy_job(trim(id));
                selected = if job.kind == "fork" { resume_fork(options.workspace, job.id) } else { resume_import(options.workspace, job.id) };
                show(selected); continue;
            }
            None() => {}
        }
        match strip_prefix(request, "/discard-copy ") {
            Some(id) => { discard_copy(options.workspace, trim(id)); println("[COPY   ] Unfinished copy discarded; original and retained copied records are preserved."); continue; }
            None() => {}
        }
        if request == "/runs" {
            for attempt in attempts(selected.id, false) limit Iterations(2147483647) {
                let json = match encode(attempt, "run conversion failed", "run encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                println("[RUN    ] " + json);
            }
            continue;
        }
        match strip_prefix(request, "/resolve-run ") {
            Some(value) => {
                let (id, note) = match split_once(trim(value), " ") { Some(parts) => parts, None() => (trim(value), "") };
                let result = resolve(selected.id, id, trim(note));
                println("[RUN    ] " + result.id + " " + result.phase + "; prior operations were not replayed.");
                continue;
            }
            None() => {}
        }
        if request == "/compact" {
            if ready_for_turn(selected.id) {
                let settings = load_settings(selected.id);
                if generation_supported(settings) { compact(selected.id, settings); println("[CONTEXT] Summary saved; full original events retained."); }
            }
            continue;
        }
        if request == "/config" {
            let value = configuration_status(load_settings(selected.id));
            let text = match encode(value, "configuration conversion failed", "configuration encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
            println("[CONFIG ] " + text);
            println("[CONFIG ] Context policy uses text estimates. Runtime token ceilings are static; command_timeout needs retained native jobs and is not active.");
            continue;
        }
        if request == "/check" {
            let settings = load_settings(selected.id);
            let session = selected.id;
            let value = handle { check_project() } with {
                SessionContext.current() => { resume session; }
                SettingsContext.current() => { resume settings; }
            };
            let text = match encode(value, "check conversion failed", "check encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
            println("[CHECK  ] " + text);
            continue;
        }
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
