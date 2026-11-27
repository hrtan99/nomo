module nomo.application.conversation.terminal;

import nomo.application.conversation.service_ports.ConversationService;
import nomo.application.commands.effects.CommandOperations;
import nomo.application.workspace.ports.WorkspaceObservations;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.application.processes.ports.ProcessOperations;
import nomo.domain.conversation.commands.{Command as TerminalCommand, ProcessRequest};
import nomo.domain.conversation.start.{Options, offline};
import nomo.domain.execution.git.GitRequest;
import nomo.application.conversation.terminal_ports.{TerminalInput, TerminalEvent, TerminalOutput};
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError;
import std.text.contains;
import nomo.application.conversation.ports.{ConversationPicker, ConversationReader, ConversationWriter, ConversationCatalog, ResultPublication};
import nomo.application.conversation.startup.select as select_start;
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.conversation.effects.ConversationOutput;
import nomo.domain.conversation.session.Session;
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.conversation.turn.{ready, supported};
import nomo.application.transfer.effects.TransferOperations;
import nomo.application.projects.effects.ProjectOperations;
import nomo.application.workspace.discovery.{find_files, search_project};
import nomo.application.execution.service.resolve;
import nomo.domain.configuration.settings.Settings;
import nomo.application.configuration.context.SettingsContext;
import nomo.domain.configuration.status.status as configuration_status;
import nomo.application.commands.checks.run as check_project;
import nomo.application.commands.requests.execute as execute_command;
import nomo.application.commands.git.execute as git_command;
import nomo.native.projects.LaunchRoot;

flow show_git(session: string, request: GitRequest) -> unit {
    let output = handle git_command(request) with { SessionContext.current() => session; };
    perform TerminalOutput.show(TerminalEvent.Git(output));
}

flow process_command(session: string, request: ProcessRequest) -> unit {
    handle match request {
            ProcessRequest.Jobs => { for value in perform ProcessOperations.list(session) { perform TerminalOutput.show(TerminalEvent.ProcessJob(value)); } }
            ProcessRequest.Exec(argv) => perform TerminalOutput.show(TerminalEvent.CommandResult(execute_command(argv.program, argv.arguments))),
            ProcessRequest.Spawn(argv) => perform TerminalOutput.show(TerminalEvent.ProcessJob(perform ProcessOperations.start(session, argv.program, argv.arguments))),
            ProcessRequest.Poll(job, bytes) => perform TerminalOutput.show(TerminalEvent.JobRead(perform ProcessOperations.read(session, job, bytes))),
            ProcessRequest.Send(job, input) => perform TerminalOutput.show(TerminalEvent.JobInput(perform ProcessOperations.write(session, job, input))),
            ProcessRequest.CloseInput(job) => perform TerminalOutput.show(TerminalEvent.JobInput(perform ProcessOperations.close_input(session, job))),
            ProcessRequest.Stop(job) => perform TerminalOutput.show(TerminalEvent.JobRead(perform ProcessOperations.stop(session, job))),
            ProcessRequest.Output(job) => perform TerminalOutput.show(TerminalEvent.JobOutput(perform ProcessOperations.output(session, job))),
        } with { SessionContext.current() => session; };
}

flow generation_supported(settings: Settings) -> bool {
    return supported(settings) with { ConversationOutput.write(line) => perform TerminalOutput.show(TerminalEvent.Message(line)); };
}
flow ready_for_turn<A ~ AttemptRepository>(attempts: A, session: string) -> bool {
    return ready(attempts, session) with { ConversationOutput.write(line) => perform TerminalOutput.show(TerminalEvent.Message(line)); };
}
flow navigation_command<C ~ ConversationService>(conversation: C, session: string, operation: string, argument: string, check: Option<Array<string>>) -> unit {
    let settings = conversation.settings(session, check);
    let result = handle match operation {
            "tree" => find_files(argument, "", 3),
            "glob" => find_files(".", argument, 0),
            _ => search_project(".", argument, true)
        } with { SessionContext.current() => session; SettingsContext.current() => settings; };
    perform TerminalOutput.show(TerminalEvent.Discovery(result));
}
flow show<A ~ AttemptRepository>(attempts: A, value: Session) -> unit {
    perform TerminalOutput.show(TerminalEvent.SessionHeader(value));
    match perform TransferOperations.status(value.id) {
        Some(job) => { if job.phase != "ready" { perform TerminalOutput.show(TerminalEvent.CopyState(job)); } },
        None() => (),
    }
    if value.pending != "" { perform TerminalOutput.show(TerminalEvent.Pending(value.pending)); }
    for attempt in attempts.list(value.id, true) { perform TerminalOutput.show(TerminalEvent.UnresolvedAttempt(attempt)); }
}
flow show_history<R ~ ConversationReader>(archive: R, session: string, query: string, first: i64, count: i64) -> unit {
    let selected = archive.load(session);
    var index = first;
    var shown: i64 = 0;
    @limits([Iterations(2147483647)]) while index < selected.next_event && (count < 0 || shown < count) {
        let item = archive.message(session, index);
        if query == "" || contains(item.text, query) || contains(item.name, query) {
            perform TerminalOutput.show(TerminalEvent.History(item));
            shown = shown + 1;
        }
        index = index + 1;
    }
    if index < selected.next_event { perform TerminalOutput.show(TerminalEvent.MoreHistory(index)); }
}
flow edit_command(session: string, operation: string, id: string) -> unit {
    handle if operation == "read" {
            perform TerminalOutput.show(TerminalEvent.File(perform WorkspaceObservations.read(session, id)));
        }
        else if operation == "list" {
            for item in perform ChangeOperations.list(session) { perform TerminalOutput.show(TerminalEvent.Edit(item)); }
        }
        else {
            let result = match operation { "undo" => perform ChangeOperations.undo(session, id), "reconcile" => perform ChangeOperations.reconcile(session, id), _ => perform ChangeOperations.rollback(session, id) };
            perform TerminalOutput.show(TerminalEvent.EditResult(result));
        } with { SessionContext.current() => session; };
}

public type TerminalApplication<
    History ~ ConversationReader + ConversationWriter + ConversationCatalog + ResultPublication,
    Attempts ~ AttemptRepository,
    Picker ~ ConversationPicker,
    Conversation ~ ConversationService,
    Input ~ TerminalInput
> = {
    @inject history: History,
    @inject attempts: Attempts,
    @inject picker: Picker,
    @inject conversation: Conversation,
    @inject input: Input,
};

impl TerminalApplication<
    History ~ ConversationReader + ConversationWriter + ConversationCatalog + ResultPublication,
    Attempts ~ AttemptRepository,
    Picker ~ ConversationPicker,
    Conversation ~ ConversationService,
    Input ~ TerminalInput
> {
    public flow run(self, options: Options) -> i32
        ![TerminalOutput, Agentic, CommandOperations, WorkspaceObservations, ChangeOperations, ProcessOperations, TransferOperations, ProjectOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] {
        let history = self.history;
        let attempts = self.attempts;
        let picker = self.picker;

        let input = self.input;
        if options.projects { perform ProjectOperations.show(); return 0; }
        match options.open_project { Some(pathname) => { perform ProjectOperations.open(pathname, options.workspace); return 0; } None() => (), }
        if options.sessions {
            let items = if options.all_sessions { history.all_sessions() } else { history.sessions(options.workspace) };
            for item in items { perform TerminalOutput.show(TerminalEvent.Project(item.workspace)); show(attempts, item); }
            return 0;
        }
        perform ProjectOperations.remember(options.workspace);
        var selected = match options.import_path {
            Some(pathname) => perform TransferOperations.load(options.workspace, pathname),
            None() => match select_start(history, history, picker, options.workspace, options.selection, !offline(options)) {
                Some(value) => value, None() => { return 0; }
            }
        };
        match options.title { Some(title) => { history.rename(selected.id, title); selected = history.load(selected.id); } None() => (), }
        if options.status { perform TerminalOutput.show(TerminalEvent.Status(selected)); return 0; }
        if options.history { show_history(history, selected.id, "", 0, -1); return 0; }
        match options.export_path { Some(pathname) => { perform TransferOperations.save(selected.id, pathname); return 0; } None() => (), }
        show(attempts, selected);
        for job in perform TransferOperations.copies(options.workspace) {
            if job.phase == "staging" || job.phase == "copying" {
                perform TerminalOutput.show(TerminalEvent.UnfinishedCopy(job));
            }
        }
        match options.once { Some(request) => { return if self.conversation.ask(selected.id, request, options.check) { 0 } else { 4 }; } None() => (), }
        perform TerminalOutput.show(TerminalEvent.Welcome);
        @limits([Iterations(2147483647)]) while true {
            let request = match input.next() { Some(value) => value, None() => { return 0; } };
            match request {
                TerminalCommand.Empty => (),
                TerminalCommand.Quit => { return 0; }
                TerminalCommand.Help => perform TerminalOutput.show(TerminalEvent.Help),
                TerminalCommand.Projects => perform ProjectOperations.show(),
                TerminalCommand.Open(value) => { perform ProjectOperations.open(value, options.workspace); }
                TerminalCommand.Git(value) => show_git(selected.id, value),
                TerminalCommand.Process(value) => process_command(selected.id, value),
                TerminalCommand.Tree(value) => navigation_command(self.conversation, selected.id, "tree", value, options.check),
                TerminalCommand.Glob(value) => navigation_command(self.conversation, selected.id, "glob", value, options.check),
                TerminalCommand.Search(value) => navigation_command(self.conversation, selected.id, "search", value, options.check),
                TerminalCommand.History(query, first, count) => show_history(history, selected.id, query, first, count),
                TerminalCommand.Fork(index) => {
                    let through = match index { Some(value) => value, None() => history.load(selected.id).next_event - 1 };
                    selected = perform TransferOperations.fork(selected.id, through); show(attempts, selected);
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
                TerminalCommand.Export(pathname) => perform TransferOperations.save(selected.id, pathname),
                TerminalCommand.Import(pathname) => { selected = perform TransferOperations.load(options.workspace, pathname); show(attempts, selected); }
                TerminalCommand.Copies => {
                    for job in perform TransferOperations.copies(options.workspace) {
                        perform TerminalOutput.show(TerminalEvent.Copy(job));
                    }
                }
                TerminalCommand.ResumeCopy(id) => {
                    let job = perform TransferOperations.job(id);
                    selected = if job.kind == "fork" { perform TransferOperations.resume_fork(options.workspace, job.id) } else { perform TransferOperations.resume_import(options.workspace, job.id) };
                    show(attempts, selected);
                }
                TerminalCommand.DiscardCopy(id) => { perform TransferOperations.discard(options.workspace, id); perform TerminalOutput.show(TerminalEvent.Message("[COPY   ] Unfinished copy discarded; original and retained copied records are preserved.")); }
                TerminalCommand.Runs => {
                    for attempt in attempts.list(selected.id, false) {
                        perform TerminalOutput.show(TerminalEvent.Run(attempt));
                    }
                }
                TerminalCommand.ResolveRun(id, note) => {
                    let result = resolve(attempts, history, history, history, selected.id, id, note);
                    perform TerminalOutput.show(TerminalEvent.Resolved(result));
                }
                TerminalCommand.Compact => {
                    if ready_for_turn(attempts, selected.id) {
                        let settings = self.conversation.settings(selected.id, options.check);
                        if generation_supported(settings) { self.conversation.compact(selected.id, settings); perform TerminalOutput.show(TerminalEvent.Message("[CONTEXT] Summary saved; full original events retained.")); }
                    }
                },
                TerminalCommand.Config => {
                    let value = configuration_status(self.conversation.settings(selected.id, options.check));
                    perform TerminalOutput.show(TerminalEvent.Config(value));
                    perform TerminalOutput.show(TerminalEvent.Message("[CONFIG ] Context policy uses text estimates. Runtime token ceilings are static; command_timeout needs retained native jobs and is not active."));
                }
                TerminalCommand.Check => {
                    let settings = self.conversation.settings(selected.id, options.check);
                    let session = selected.id;
                    let value = handle check_project() with {
                        SessionContext.current() => session;
                        SettingsContext.current() => settings;
                    };
                    perform TerminalOutput.show(TerminalEvent.Check(value));
                }
                TerminalCommand.Status => perform TerminalOutput.show(TerminalEvent.Status(history.load(selected.id))),
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
    Conversation ~ ConversationService,
    Input ~ TerminalInput
>() -> TerminalApplication<History, Attempts, Picker, Conversation, Input> {
    return TerminalApplication<History, Attempts, Picker, Conversation, Input> {};
}
