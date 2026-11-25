module nomo.native.entry;

import std.io.{println, print, read_line};
import std.text.{trim, contains, from_i64, from_i32};
import nomo.entry.native.commands.{Command as TerminalCommand, ProcessRequest, command};
import nomo.native.agent.NativeCoding;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.core.json.encode;
import nomo.entry.native.options.parse;
import nomo.native.history.{SessionContext, Session};
import nomo.adapters.etas.conversations.{NativeHistory, rename, read_message as message, fork, copy_status, copy_jobs, copy_job, resume_fork, discard_copy};
import nomo.application.native.conversation.ports.{ConversationReader, ConversationWriter, ConversationCatalog, GenerationReservation};
import nomo.native.context.{RollingContext, ContextProjection, build as build_context, compact};
import nomo.native.transfer.{save_archive, load_archive, resume_import};
import nomo.native.mutations.{journals, undo_changes, rollback_changes, reconcile_changes};
import nomo.native.files.read_file;
import nomo.native.navigation.{find_files, search_project};
import nomo.bootstrap.execution.{attempts, begin, dispatching, returned, complete_attempt, resolve};
import nomo.domain.configuration.settings.{Settings, effective_window, as_number, estimated_tokens};
import nomo.native.configuration.{SettingsContext, load as load_configuration, status as configuration_status};
import nomo.native.terminal.check_project;
import nomo.native.terminal.run_command;
import nomo.native.processes.{start_job, read_job, write_job, close_job_input, stop_job, list_jobs, job_output};
import nomo.native.projects.{LaunchRoot, remember, show_projects, request_open};
import nomo.native.git.shortcut as git_shortcut;

flow process_json<T>(value: T) -> string {
    return match encode(value, "process conversion failed", "process encoding failed") { Ok(text) => text, Err(error) => { abort(error); } };
}

flow git_command(session: string, argument: string) -> unit {
    let output = handle { git_shortcut(argument) } with { SessionContext.current() => { resume session; } };
    println("[GIT    ] " + process_json(output));
}

flow print_job<T>(value: T) -> unit { println("[JOB    ] " + process_json(value)); }

flow process_command(session: string, request: ProcessRequest) -> unit {
    handle {
        match request {
            ProcessRequest.Jobs => { for value in list_jobs() limit Iterations(2147483647) { print_job(value); } }
            ProcessRequest.Exec(argv) => { print_job(run_command(argv.program, argv.arguments)); }
            ProcessRequest.Spawn(argv) => { print_job(start_job(argv.program, argv.arguments)); }
            ProcessRequest.Poll(job, bytes) => { print_job(read_job(job, bytes)); }
            ProcessRequest.Send(job, input) => { print_job(write_job(job, input)); }
            ProcessRequest.CloseInput(job) => { print_job(close_job_input(job)); }
            ProcessRequest.Stop(job) => { print_job(stop_job(job)); }
            ProcessRequest.Output(job) => { print_job(job_output(job)); }
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
    var input = build_context(archive, session, request, settings);
    if projection.needs_compaction(input) {
        println("[CONTEXT] Summarizing; complete original history stays saved.");
        compact(archive, archive, session, settings);
        input = build_context(archive, session, request, settings);
    }
    if estimated_tokens(projection.bytes(input)) > as_number(effective_window(settings) - settings.max_output_tokens) {
        println("[CONTEXT] Saved summary and retained input still exceed the configured context estimate. No coding model request was submitted; complete original history remains saved.");
        return false;
    }
    archive.reserve(session, false, projection.bytes(input));
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

public flow run(args: Array<string>) -> i32
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
    let options = parse(args);
    if options.choose_project { request_open("", options.workspace); return 0; }
    remember(options.workspace);
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
        let request = command(trim(raw));
        match request {
            TerminalCommand.Empty => {}
            TerminalCommand.Quit => { return 0; }
            TerminalCommand.Help => {
                println("Projects: /projects, /open [FOLDER_OR_NUMBER]. Project selection is native; the launcher attaches that folder's execution endpoint and keeps the current endpoint running.");
                println("Git: /git status, diff [--staged] [JSON_PATHS], log [COUNT], branches, init, branch NAME, switch NAME, commit JSON. Commit JSON contains message and paths.");
                println("Ask about the project; native tools provide recursive/glob discovery, literal/regex search, file reads, approved editing and Git operations.");
                println("Terminal: /exec JSON_ARGV, /spawn JSON_ARGV, /jobs, /poll JOB [MAX_BYTES], /send JOB JSON_STRING, /close-input JOB, /stop JOB, /job-output JOB. /poll waits for output or termination. Saved job phases are historical observations; current Host handles are not durable across process restart.");
                println("/new [TITLE], /sessions, /resume ID, /rename TITLE, /history [TEXT], /page EVENT, /fork [EVENT], /export FILE, /import FILE, /copies, /resume-copy ID, /discard-copy ID, /runs, /resolve-run ID [NOTE], /config, /check, /compact, /status, /tree [PATH], /glob PATTERN, /search REGEX, /read FILE, /edits, /undo [EDIT], /rollback EDIT, /recover EDIT, /quit");
            }
            TerminalCommand.Projects => { show_projects(); }
            TerminalCommand.Open(value) => { request_open(value, options.workspace); }
            TerminalCommand.Git(value) => { git_command(selected.id, value); }
            TerminalCommand.Process(value) => { process_command(selected.id, value); }
            TerminalCommand.Tree(value) => { navigation_command(selected.id, "tree", value); }
            TerminalCommand.Glob(value) => { navigation_command(selected.id, "glob", value); }
            TerminalCommand.Search(value) => { navigation_command(selected.id, "search", value); }
            TerminalCommand.History(query, first, count) => { show_history(selected.id, query, first, count); }
            TerminalCommand.Fork(index) => {
                let through = match index { Some(value) => value, None() => archive.load(selected.id).next_event - 1 };
                selected = fork(selected.id, through); show(selected);
            }
            TerminalCommand.Read(value) => { edit_command(selected.id, "read", value); }
            TerminalCommand.Edits => { edit_command(selected.id, "list", ""); }
            TerminalCommand.Undo(value) => { edit_command(selected.id, "undo", value); }
            TerminalCommand.Rollback(value) => { edit_command(selected.id, "rollback", value); }
            TerminalCommand.Recover(value) => { edit_command(selected.id, "reconcile", value); }
            TerminalCommand.Sessions => { for item in archive.sessions(options.workspace) limit Iterations(2147483647) { show(item); } }
            TerminalCommand.New(title) => { selected = archive.create(options.workspace, title); show(selected); }
            TerminalCommand.Resume(id) => { selected = archive.select(options.workspace, id); show(selected); }
            TerminalCommand.Rename(title) => { rename(selected.id, title); selected = archive.load(selected.id); show(selected); }
            TerminalCommand.Export(pathname) => { save_archive(selected.id, pathname); }
            TerminalCommand.Import(pathname) => { selected = load_archive(options.workspace, pathname); show(selected); }
            TerminalCommand.Copies => {
                for job in copy_jobs(options.workspace) limit Iterations(2147483647) {
                    let json = match encode(job, "copy conversion failed", "copy encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                    println("[COPY   ] " + json);
                }
            }
            TerminalCommand.ResumeCopy(id) => {
                let job = copy_job(id);
                selected = if job.kind == "fork" { resume_fork(options.workspace, job.id) } else { resume_import(options.workspace, job.id) };
                show(selected);
            }
            TerminalCommand.DiscardCopy(id) => { discard_copy(options.workspace, id); println("[COPY   ] Unfinished copy discarded; original and retained copied records are preserved."); }
            TerminalCommand.Runs => {
                for attempt in attempts(selected.id, false) limit Iterations(2147483647) {
                    let json = match encode(attempt, "run conversion failed", "run encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                    println("[RUN    ] " + json);
                }
            }
            TerminalCommand.ResolveRun(id, note) => {
                let result = resolve(selected.id, id, note);
                println("[RUN    ] " + result.id + " " + result.phase + "; prior operations were not replayed.");
            }
            TerminalCommand.Compact => {
                if ready_for_turn(selected.id) {
                    let settings = load_settings(selected.id);
                    if generation_supported(settings) { compact(archive, archive, selected.id, settings); println("[CONTEXT] Summary saved; full original events retained."); }
                }
            }
            TerminalCommand.Config => {
                let value = configuration_status(load_settings(selected.id));
                let text = match encode(value, "configuration conversion failed", "configuration encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                println("[CONFIG ] " + text);
                println("[CONFIG ] Context policy uses text estimates. Runtime token ceilings are static; command_timeout needs retained native jobs and is not active.");
            }
            TerminalCommand.Check => {
                let settings = load_settings(selected.id);
                let session = selected.id;
                let value = handle { check_project() } with {
                    SessionContext.current() => { resume session; }
                    SettingsContext.current() => { resume settings; }
                };
                let text = match encode(value, "check conversion failed", "check encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                println("[CHECK  ] " + text);
            }
            TerminalCommand.Status => {
                let status = match encode(archive.load(selected.id), "status conversion failed", "status encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
                println("[STATUS ] " + status);
                println("[BUDGET ] generation_allowance is configured allowance; context_bytes is an estimate, not measured token usage.");
            }
            TerminalCommand.Ask(value) => { ask(selected.id, value); }
        }
    }
    return 0;
}
