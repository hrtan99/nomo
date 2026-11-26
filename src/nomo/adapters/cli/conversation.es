module nomo.adapters.cli.conversation;

import nomo.application.conversation.service_ports.ConversationService;

import nomo.application.commands.effects.CommandOperations;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.application.processes.ports.ProcessOperations;
import std.io.{println, print, read_line};
import std.text.{trim, contains, from_i64, from_i32};
import nomo.adapters.cli.native.commands.{Command as TerminalCommand, ProcessRequest, command};
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.domain.serialization.json.encode;
import nomo.adapters.cli.native.options.{parse, offline};
import nomo.application.conversation.ports.{ConversationPicker, ConversationReader, ConversationWriter, ConversationCatalog, ResultPublication};
import nomo.application.conversation.startup.select as select_start;
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.conversation.effects.ConversationOutput;
import nomo.domain.conversation.session.Session;
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.conversation.turn.{ready, supported};
import nomo.adapters.filesystem.transfer_tools.{save_archive, load_archive, resume_import, fork, copy_status, copy_jobs, copy_job, resume_fork, discard_copy};
import nomo.application.transfer.effects.TransferOperations;
import nomo.application.projects.effects.ProjectOperations;
import nomo.adapters.model.tools.mutations.{journals, undo_changes, rollback_changes, reconcile_changes};
import nomo.adapters.filesystem.files.read_file;
import nomo.adapters.filesystem.navigation.{find_files, search_project};
import nomo.application.execution.service.resolve;
import nomo.domain.configuration.settings.Settings;
import nomo.application.configuration.context.SettingsContext;
import nomo.domain.configuration.status.status as configuration_status;
import nomo.adapters.process.commands.{check_project, run_command};
import nomo.adapters.model.tools.processes.{start_job, read_job, write_job, close_job_input, stop_job, list_jobs, job_output};
import nomo.native.projects.LaunchRoot;
import nomo.adapters.model.tools.projects.{remember, show_projects, request_open};
import nomo.adapters.process.git.shortcut as git_shortcut;

flow process_json<T>(value: T) -> string {
    return match encode(value, "process conversion failed", "process encoding failed") { Ok(text) => text, Err(error) => abort(error), };
}

flow git_command(session: string, argument: string) -> unit {
    let output = handle git_shortcut(argument) with { SessionContext.current() => session; };
    println("[GIT    ] " + process_json(output));
}

flow print_job<T>(value: T) -> unit { println("[JOB    ] " + process_json(value)); }

flow process_command(session: string, request: ProcessRequest) -> unit {
    handle match request {
            ProcessRequest.Jobs => { for value in list_jobs() { print_job(value); } }
            ProcessRequest.Exec(argv) => print_job(run_command(argv.program, argv.arguments)),
            ProcessRequest.Spawn(argv) => print_job(start_job(argv.program, argv.arguments)),
            ProcessRequest.Poll(job, bytes) => print_job(read_job(job, bytes)),
            ProcessRequest.Send(job, input) => print_job(write_job(job, input)),
            ProcessRequest.CloseInput(job) => print_job(close_job_input(job)),
            ProcessRequest.Stop(job) => print_job(stop_job(job)),
            ProcessRequest.Output(job) => print_job(job_output(job)),
        } with { SessionContext.current() => session; };
}

flow generation_supported(settings: Settings) -> bool {
    return supported(settings) with { ConversationOutput.write(line) => println(line); };
}

flow ready_for_turn<A ~ AttemptRepository>(attempts: A, session: string) -> bool {
    return ready(attempts, session) with { ConversationOutput.write(line) => println(line); };
}

flow navigation_command<C ~ ConversationService>(conversation: C, session: string, operation: string, argument: string, check: Option<Array<string>>) -> unit {
    let settings = conversation.settings(session, check);
    let result = handle match operation {
            "tree" => find_files(argument, "", 3),
            "glob" => find_files(".", argument, 0),
            _ => search_project(".", argument, true)
        } with { SessionContext.current() => session; SettingsContext.current() => settings; };
    println(result.stdout);
    if result.stderr != "" { println(result.stderr); }
    if result.exit_code > 1 { println("[ERROR  ] Project discovery exited " + from_i32(result.exit_code)); }
}

flow show<A ~ AttemptRepository>(attempts: A, value: Session) -> unit {
    println("[SESSION] " + value.id + " · " + value.title);
    match copy_status(value.id) {
        Some(job) => { if job.phase != "ready" { println("[COPY   ] " + job.phase + "; /resume-copy " + job.id + " or /discard-copy " + job.id); } },
        None() => (),
    }
    if value.pending != "" {
        println("[PENDING] " + value.pending + " has no recorded completion. Inspect actual state; it is not automatically replayed.");
    }
    for attempt in attempts.list(value.id, true) {
        println("[RUN    ] " + attempt.id + " " + attempt.kind + " " + attempt.phase + "; no completion recorded. Inspect actual state, then /resolve-run ID [NOTE].");
    }
}

flow show_history<R ~ ConversationReader>(archive: R, session: string, query: string, first: i64, count: i64) -> unit {
    let selected = archive.load(session);
    var index = first;
    var shown: i64 = 0;
    @limits([Iterations(2147483647)]) while index < selected.next_event && (count < 0 || shown < count) {
        let item = archive.message(session, index);
        if query == "" || contains(item.text, query) || contains(item.name, query) {
            println("[" + item.role + "/" + item.name + " #" + item.id + "] " + item.text);
            shown = shown + 1;
        }
        index = index + 1;
    }
    if index < selected.next_event { println("[HISTORY] More events remain; /page " + from_i64(index)); }
}

flow show_status(value: Session) -> unit {
    let status = match encode(value, "status conversion failed", "status encoding failed") { Ok(value) => value, Err(error) => abort(error), };
    println("[STATUS ] " + status);
    println("[BUDGET ] generation_allowance is configured allowance; context_bytes is an estimate, not measured token usage.");
}

flow edit_command(session: string, operation: string, id: string) -> unit {
    handle if operation == "read" {
            let result = read_file(id);
            let json = match encode(result, "file conversion failed", "file encoding failed") { Ok(value) => value, Err(error) => abort(error), };
            println("[FILE   ] " + json);
        }
        else if operation == "list" {
            for item in journals() {
                let json = match encode(item, "edit conversion failed", "edit encoding failed") { Ok(value) => value, Err(error) => abort(error), };
                println("[EDIT   ] " + json);
            }
        }
        else {
            let result = match operation { "undo" => undo_changes(id), "reconcile" => reconcile_changes(id), _ => rollback_changes(id) };
            let json = match encode(result, "edit result conversion failed", "edit result encoding failed") { Ok(value) => value, Err(error) => abort(error), };
            println("[EDIT   ] " + json);
        } with { SessionContext.current() => session; };
}

public type TerminalApplication<
    History ~ ConversationReader + ConversationWriter + ConversationCatalog + ResultPublication,
    Attempts ~ AttemptRepository,
    Picker ~ ConversationPicker,
    Conversation ~ ConversationService
> = {
    @inject history: History,
    @inject attempts: Attempts,
    @inject picker: Picker,
    @inject conversation: Conversation,
};

impl TerminalApplication<
    History ~ ConversationReader + ConversationWriter + ConversationCatalog + ResultPublication,
    Attempts ~ AttemptRepository,
    Picker ~ ConversationPicker,
    Conversation ~ ConversationService
> {
    public flow run(self, args: Array<string>) -> i32
        ![Agentic, CommandOperations, ProjectInstructions, ChangeOperations, ProcessOperations, TransferOperations, ProjectOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
        let history = self.history;
        let attempts = self.attempts;
        let picker = self.picker;

        let options = parse(args);
        if options.projects { show_projects(); return 0; }
        match options.open_project { Some(pathname) => { request_open(pathname, options.workspace); return 0; } None() => (), }
        if options.sessions {
            let items = if options.all_sessions { history.all_sessions() } else { history.sessions(options.workspace) };
            for item in items { println("[PROJECT] " + item.workspace); show(attempts, item); }
            return 0;
        }
        remember(options.workspace);
        var selected = match options.import_path {
            Some(pathname) => load_archive(options.workspace, pathname),
            None() => match select_start(history, history, picker, options.workspace, options.selection, !offline(options)) {
                Some(value) => value, None() => { return 0; }
            }
        };
        match options.title { Some(title) => { history.rename(selected.id, title); selected = history.load(selected.id); } None() => (), }
        if options.status { show_status(selected); return 0; }
        if options.history { show_history(history, selected.id, "", 0, -1); return 0; }
        match options.export_path { Some(pathname) => { save_archive(selected.id, pathname); return 0; } None() => (), }
        show(attempts, selected);
        for job in copy_jobs(options.workspace) {
            if job.phase == "staging" || job.phase == "copying" {
                println("[COPY   ] Unfinished " + job.kind + " " + job.id + "; /resume-copy " + job.id + " or /discard-copy " + job.id);
            }
        }
        match options.once { Some(request) => { return if self.conversation.ask(selected.id, request, options.check) { 0 } else { 4 }; } None() => (), }
        println("[NATIVE ] Nomo native chat · /help · /quit");
        @limits([Iterations(2147483647)]) while true {
            print("nomo> ");
            let raw = read_line();
            if raw == "" { return 0; }
            let request = command(trim(raw));
            match request {
                TerminalCommand.Empty => (),
                TerminalCommand.Quit => { return 0; }
                TerminalCommand.Help => {
                    println("Projects: /projects, /open [FOLDER_OR_NUMBER]. Project selection is native; the launcher attaches that folder's execution endpoint and keeps the current endpoint running.");
                    println("Git: /git status, diff [--staged] [JSON_PATHS], log [COUNT], branches, init, branch NAME, switch NAME, commit JSON. Commit JSON contains message and paths.");
                    println("Ask about the project; native tools provide recursive/glob discovery, literal/regex search, file reads, approved editing and Git operations.");
                    println("Terminal: /exec JSON_ARGV, /spawn JSON_ARGV, /jobs, /poll JOB [MAX_BYTES], /send JOB JSON_STRING, /close-input JOB, /stop JOB, /job-output JOB. /poll waits for output or termination. Saved job phases are historical observations; current Host handles are not durable across process restart.");
                    println("/new [TITLE], /sessions, /resume ID, /rename TITLE, /history [TEXT], /page EVENT, /fork [EVENT], /export FILE, /import FILE, /copies, /resume-copy ID, /discard-copy ID, /runs, /resolve-run ID [NOTE], /config, /check, /compact, /status, /tree [PATH], /glob PATTERN, /search REGEX, /read FILE, /edits, /undo [EDIT], /rollback EDIT, /recover EDIT, /quit");
                }
                TerminalCommand.Projects => show_projects(),
                TerminalCommand.Open(value) => { request_open(value, options.workspace); }
                TerminalCommand.Git(value) => git_command(selected.id, value),
                TerminalCommand.Process(value) => process_command(selected.id, value),
                TerminalCommand.Tree(value) => navigation_command(self.conversation, selected.id, "tree", value, options.check),
                TerminalCommand.Glob(value) => navigation_command(self.conversation, selected.id, "glob", value, options.check),
                TerminalCommand.Search(value) => navigation_command(self.conversation, selected.id, "search", value, options.check),
                TerminalCommand.History(query, first, count) => show_history(history, selected.id, query, first, count),
                TerminalCommand.Fork(index) => {
                    let through = match index { Some(value) => value, None() => history.load(selected.id).next_event - 1 };
                    selected = fork(selected.id, through); show(attempts, selected);
                }
                TerminalCommand.Read(value) => edit_command(selected.id, "read", value),
                TerminalCommand.Edits => edit_command(selected.id, "list", ""),
                TerminalCommand.Undo(value) => edit_command(selected.id, "undo", value),
                TerminalCommand.Rollback(value) => edit_command(selected.id, "rollback", value),
                TerminalCommand.Recover(value) => edit_command(selected.id, "reconcile", value),
                TerminalCommand.Sessions => { for item in history.sessions(options.workspace) { show(attempts, item); } }
                TerminalCommand.New(title) => { selected = history.create(options.workspace, title); show(attempts, selected); }
                TerminalCommand.Resume(id) => { selected = history.select(options.workspace, id); show(attempts, selected); }
                TerminalCommand.Rename(title) => { history.rename(selected.id, title); selected = history.load(selected.id); show(attempts, selected); }
                TerminalCommand.Export(pathname) => save_archive(selected.id, pathname),
                TerminalCommand.Import(pathname) => { selected = load_archive(options.workspace, pathname); show(attempts, selected); }
                TerminalCommand.Copies => {
                    for job in copy_jobs(options.workspace) {
                        let json = match encode(job, "copy conversion failed", "copy encoding failed") { Ok(value) => value, Err(error) => abort(error), };
                        println("[COPY   ] " + json);
                    }
                }
                TerminalCommand.ResumeCopy(id) => {
                    let job = copy_job(id);
                    selected = if job.kind == "fork" { resume_fork(options.workspace, job.id) } else { resume_import(options.workspace, job.id) };
                    show(attempts, selected);
                }
                TerminalCommand.DiscardCopy(id) => { discard_copy(options.workspace, id); println("[COPY   ] Unfinished copy discarded; original and retained copied records are preserved."); }
                TerminalCommand.Runs => {
                    for attempt in attempts.list(selected.id, false) {
                        let json = match encode(attempt, "run conversion failed", "run encoding failed") { Ok(value) => value, Err(error) => abort(error), };
                        println("[RUN    ] " + json);
                    }
                }
                TerminalCommand.ResolveRun(id, note) => {
                    let result = resolve(attempts, history, history, history, selected.id, id, note);
                    println("[RUN    ] " + result.id + " " + result.phase + "; prior operations were not replayed.");
                }
                TerminalCommand.Compact => {
                    if ready_for_turn(attempts, selected.id) {
                        let settings = self.conversation.settings(selected.id, options.check);
                        if generation_supported(settings) { self.conversation.compact(selected.id, settings); println("[CONTEXT] Summary saved; full original events retained."); }
                    }
                },
                TerminalCommand.Config => {
                    let value = configuration_status(self.conversation.settings(selected.id, options.check));
                    let text = match encode(value, "configuration conversion failed", "configuration encoding failed") { Ok(value) => value, Err(error) => abort(error), };
                    println("[CONFIG ] " + text);
                    println("[CONFIG ] Context policy uses text estimates. Runtime token ceilings are static; command_timeout needs retained native jobs and is not active.");
                }
                TerminalCommand.Check => {
                    let settings = self.conversation.settings(selected.id, options.check);
                    let session = selected.id;
                    let value = handle check_project() with {
                        SessionContext.current() => session;
                        SettingsContext.current() => settings;
                    };
                    let text = match encode(value, "check conversion failed", "check encoding failed") { Ok(value) => value, Err(error) => abort(error), };
                    println("[CHECK  ] " + text);
                }
                TerminalCommand.Status => show_status(history.load(selected.id)),
                TerminalCommand.Ask(value) => { self.conversation.ask(selected.id, value, options.check); }
            }
        }
        return 0;
    }
}

public flow application<
    History ~ ConversationReader + ConversationWriter + ConversationCatalog + ResultPublication,
    Attempts ~ AttemptRepository,
    Picker ~ ConversationPicker,
    Conversation ~ ConversationService
>() -> TerminalApplication<History, Attempts, Picker, Conversation> {
    return TerminalApplication<History, Attempts, Picker, Conversation> {};
}
