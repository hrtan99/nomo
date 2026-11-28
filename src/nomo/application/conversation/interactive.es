module nomo.application.conversation.interactive;

import nomo.application.conversation.ports.{
    ConversationCatalog,
    ConversationOutput,
    ConversationPicker,
    ConversationReader,
    ConversationService,
    ConversationWriter,
    ResultPublication,
    TerminalDisplay,
    TerminalEvent,
    TerminalInput,
    TerminalOutput
};
import nomo.application.conversation.session.{ready, select, supported};
import nomo.application.editing.ports.ChangeOperations;
import nomo.application.execution.attempts.resolve;
import nomo.application.execution.commands.{checks_run, commands_requests_execute, git_execute};
import nomo.application.execution.ports.{AttemptRepository, CommandOperations, ProcessOperations};
import nomo.application.resources.{LaunchRoot, ProjectRoot};
import nomo.application.scope.{SessionContext, SettingsContext};
import nomo.application.transfer.ports.TransferOperations;
import nomo.application.workspace.ports.{ProjectOperations, WorkspaceObservations};
import nomo.application.workspace.service.{find_files, search_project};
import nomo.domain.commands.{Command as commands_Command, GitRequest, ProcessRequest};
import nomo.domain.conversation.{EntryMode, Options, SavedSession, SessionSelection, forwarded, offline};
import nomo.domain.settings.{Settings, status};
import nomo.domain.workspace.LaunchRequest;
import std.effects.Fs;
import std.fs.{IOError, ReadLimitError};
import std.io.IOError as io_IOError;
import std.text.contains;

// Pure control state only: no admission, durable fact, approval or work authority.
public enum State {
    First,
    Second,
    Stopped(i32)
}

public flow fresh(continuing: bool) -> State {
    return if continuing {
        State.Second
    } else {
        State.First
    };
}

public flow turn(state: State) -> i32 {
    return match state {
        State.First => 1,
        State.Second => 2,
        State.Stopped(last) => last
    };
}

public flow work_error(state: State) -> string {
    return match state {
        State.First => "",
        State.Second => "",
        State.Stopped(_) => "terminal session stopped; no retry or third turn",
    };
}

// Only the existing work-chain call's confirmed success may advance the session.
// Help/show/EOF never call this transition; --once always ends the invocation.
public flow after_turn(state: State, confirmed: bool, once: bool) -> Result<State, string> {
    return match state {
        State.First => Ok(if confirmed && !once {
            State.Second
        } else {
            State.Stopped(1)
        }),
        State.Second => Ok(State.Stopped(2)),
        State.Stopped(_) => Err("terminal session stopped; no retry or third turn"),
    };
}

flow show_git(session: string, request: GitRequest) -> unit {
    let output = handle git_execute(request) with {
        SessionContext.current() => session;
    };
    perform TerminalOutput.show(TerminalEvent.Git(output));
}

flow process_command(session: string, request: ProcessRequest) -> unit {
    handle match request {
        ProcessRequest.Jobs => {
            for value in perform ProcessOperations.list(session) {
                perform TerminalOutput.show(TerminalEvent.ProcessJob(value));
            }
            for value in perform ProcessOperations.archived_jobs(session) {
                perform TerminalOutput.show(TerminalEvent.ArchivedJob(value));
            }
        }
        ProcessRequest.Exec(argv) => perform TerminalOutput.show(
            TerminalEvent.CommandResult(commands_requests_execute(argv.program, argv.arguments))
        ),
        ProcessRequest.Spawn(argv) => perform TerminalOutput.show(
            TerminalEvent.ProcessJob(perform ProcessOperations.start(session, argv.program, argv.arguments))
        ),
        ProcessRequest.Poll(job, bytes) => perform TerminalOutput.show(
            TerminalEvent.JobRead(perform ProcessOperations.read(session, job, bytes))
        ),
        ProcessRequest.Send(job, input) => perform TerminalOutput.show(
            TerminalEvent.JobInput(perform ProcessOperations.write(session, job, input))
        ),
        ProcessRequest.CloseInput(job) => perform TerminalOutput.show(
            TerminalEvent.JobInput(perform ProcessOperations.close_input(session, job))
        ),
        ProcessRequest.Stop(job) => perform TerminalOutput.show(
            TerminalEvent.JobRead(perform ProcessOperations.stop(session, job))
        ),
        ProcessRequest.Output(job) => perform TerminalOutput.show(
            TerminalEvent.JobOutput(perform ProcessOperations.output(session, job))
        ),
        ProcessRequest.ArchivedOutput(job, part) => perform TerminalOutput.show(
            TerminalEvent.ArchivedOutput(perform ProcessOperations.archived_output(session, job, part))
        ),
    } with {
        SessionContext.current() => session;
    };
}

flow generation_supported(settings: Settings) -> bool {
    return supported(settings) with {
        ConversationOutput.write(line) => perform TerminalOutput.show(TerminalEvent.Message(line));
    };
}

flow ready_for_turn<A ~ AttemptRepository>(attempts: A, session: string) -> bool {
    return ready(attempts, session) with {
        ConversationOutput.write(line) => perform TerminalOutput.show(TerminalEvent.Message(line));
    };
}

flow navigation_command<C ~ ConversationService>(
    conversation: C,
    session: string,
    operation: string,
    argument: string,
    check: Option<Array<string>>
) -> unit {
    let settings = conversation.settings(session, check);
    let result = handle match operation {
        "tree" => find_files(argument, "", 3),
        "glob" => find_files(".", argument, 0),
        _ => search_project(".", argument, true)
    } with {
        SessionContext.current() => session;
        SettingsContext.current() => settings;
    };
    perform TerminalOutput.show(TerminalEvent.Discovery(result));
}

flow show<A ~ AttemptRepository>(attempts: A, value: SavedSession) -> unit {
    perform TerminalOutput.show(TerminalEvent.SessionHeader(value));
    match perform TransferOperations.status(value.id) {
        Some(job) => {
            if job.phase != "ready" {
                perform TerminalOutput.show(TerminalEvent.CopyState(job));
            }
        },
        None() => (),
    }
    if value.pending != "" {
        perform TerminalOutput.show(TerminalEvent.Pending(value.pending));
    }
    for attempt in attempts.list(value.id, true) {
        perform TerminalOutput.show(TerminalEvent.UnresolvedAttempt(attempt));
    }
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
    if index < selected.next_event {
        perform TerminalOutput.show(TerminalEvent.MoreHistory(index));
    }
}

flow edit_command(session: string, operation: string, id: string) -> unit {
    handle if operation == "read" {
        perform TerminalOutput.show(TerminalEvent.File(perform WorkspaceObservations.read(session, id)));
    }
    else if operation == "list" {
        for item in perform ChangeOperations.list(session) {
            perform TerminalOutput.show(TerminalEvent.Edit(item));
        }
    }
    else {
        let result = match operation {
            "undo" => perform ChangeOperations.undo(session, id),
            "reconcile" => perform ChangeOperations.reconcile(session, id),
            _ => perform ChangeOperations.rollback(session, id)
        };
        perform TerminalOutput.show(TerminalEvent.EditResult(result));
    } with {
        SessionContext.current() => session;
    };
}

public type TerminalApplication<
    History ~ ConversationReader + ConversationWriter + ConversationCatalog
        + ResultPublication,
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
    History ~ ConversationReader + ConversationWriter + ConversationCatalog
        + ResultPublication,
    Attempts ~ AttemptRepository,
    Picker ~ ConversationPicker,
    Conversation ~ ConversationService,
    Input ~ TerminalInput
> {
    public flow run(self, options: Options, mode: EntryMode) -> i32
    ![
        TerminalOutput,
        Agentic,
        CommandOperations,
        WorkspaceObservations,
        ChangeOperations,
        ProcessOperations,
        TransferOperations,
        ProjectOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Command.start<DefaultCommandSandbox>,
        Command.reconnect<DefaultCommandSandbox>,
        Command.read<DefaultCommandSandbox>,
        Command.write<DefaultCommandSandbox>,
        Command.stop<DefaultCommandSandbox>,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Fs.stat<ProjectRoot>,
        Fs.atomic_replace<ProjectRoot>,
        Fs.atomic_replace<LaunchRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<ReadLimitError>,
        Error<io_IOError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ] {
        let history = self.history;
        let attempts = self.attempts;
        let picker = self.picker;
        let input = self.input;
        if mode == EntryMode.Attach {
            match options.once {
                Some(_) => abort("one-shot requests use a separate native invocation"),
                None() => (),
            }
            match options.check {
                Some(_) => abort("a running endpoint keeps its check override; use --once or start a new endpoint"),
                None() => (),
            }
        }
        if options.projects {
            perform ProjectOperations.show();
            return 0;
        }
        match options.open_project {
            Some(pathname) => {
                perform ProjectOperations.open(
                    pathname,
                    options.workspace,
                    forwarded(options, options.selection)
                );
                return 0;
            }
            None() => (),
        }
        if options.sessions {
            let items = if options.all_sessions {
                history.all_sessions()
            } else {
                history.sessions(options.workspace)
            };
            for item in items {
                perform TerminalOutput.show(TerminalEvent.Project(item.workspace));
                show(attempts, item);
            }
            return 0;
        }
        var selected = match options.import_path {
            Some(pathname) => perform TransferOperations.load(options.workspace, pathname),
            None() => match select(
                history,
                history,
                picker,
                options.workspace,
                options.selection,
                !offline(options),
                options.all_sessions
            ) {
                Some(value) => value,
                None() => {
                    return 0;
                }
            }
        };
        if selected.workspace != options.workspace && !options.status && !options.history {
            perform ProjectOperations.launch(
                LaunchRequest {
                    workspace = selected.workspace,
                    arguments = forwarded(options, SessionSelection.Exact(selected.id))
                }
            );
            return 0;
        }
        perform ProjectOperations.remember(selected.workspace);
        match options.title {
            Some(title) => {
                history.rename(selected.id, title);
                selected = history.load(selected.id);
            }
            None() => (),
        }
        if options.status {
            perform TerminalOutput.show(TerminalEvent.Status(selected));
            return 0;
        }
        if options.history {
            show_history(history, selected.id, "", 0, -1);
            return 0;
        }
        match options.export_path {
            Some(pathname) => {
                perform TransferOperations.save(selected.id, pathname);
                return 0;
            }
            None() => (),
        }
        show(attempts, selected);
        if mode == EntryMode.Attach {
            perform TerminalOutput.show(TerminalEvent.Message("[SESSION] The next terminal command uses this conversation. Any in-flight operation keeps its original session; no terminal input or approval answer is injected."));
            return 0;
        }
        for job in perform TransferOperations.copies(options.workspace) {
            if job.phase == "staging" || job.phase == "copying" {
                perform TerminalOutput.show(TerminalEvent.UnfinishedCopy(job));
            }
        }
        match options.once {
            Some(request) => {
                return if self.conversation.ask(selected.id, request, options.check) {
                    0
                } else {
                    4
                };
            }
            None() => (),
        }
        perform TerminalOutput.show(TerminalEvent.Welcome);
        @limits([Iterations(2147483647)]) while true {
            let request = match input.next() {
                Some(value) => value,
                None() => {
                    return 0;
                }
            };
            // Another explicit startup may select a session while this Host is
            // waiting for input. Adopt it only at the next command boundary.
            match history.selected(options.workspace) {
                Some(id) => {
                    if id != selected.id {
                        selected = history.load(id);
                        show(attempts, selected);
                    }
                }
                None() => (),
            }
            match request {
                commands_Command.Empty => (),
                commands_Command.Quit => {
                    return 0;
                }
                commands_Command.Help => perform TerminalOutput.show(TerminalEvent.Help),
                commands_Command.Projects => perform ProjectOperations.show(),
                commands_Command.Open(value) => {
                    perform ProjectOperations.open(value, options.workspace, []);
                }
                commands_Command.Git(value) => show_git(selected.id, value),
                commands_Command.Process(value) => process_command(selected.id, value),
                commands_Command.Tree(value) => navigation_command(
                    self.conversation,
                    selected.id,
                    "tree",
                    value,
                    options.check
                ),
                commands_Command.Glob(value) => navigation_command(
                    self.conversation,
                    selected.id,
                    "glob",
                    value,
                    options.check
                ),
                commands_Command.Search(value) => navigation_command(
                    self.conversation,
                    selected.id,
                    "search",
                    value,
                    options.check
                ),
                commands_Command.History(query, first, count) => show_history(
                    history,
                    selected.id,
                    query,
                    first,
                    count
                ),
                commands_Command.Fork(index) => {
                    let through = match index {
                        Some(value) => value,
                        None() => history.load(selected.id).next_event - 1
                    };
                    selected = perform TransferOperations.fork(selected.id, through);
                    show(attempts, selected);
                }
                commands_Command.Read(value) => edit_command(selected.id, "read", value),
                commands_Command.Edits => edit_command(selected.id, "list", ""),
                commands_Command.Undo(value) => edit_command(selected.id, "undo", value),
                commands_Command.Rollback(value) => edit_command(selected.id, "rollback", value),
                commands_Command.Recover(value) => edit_command(selected.id, "reconcile", value),
                commands_Command.Sessions(all) => {
                    let items = if all {
                        history.all_sessions()
                    } else {
                        history.sessions(options.workspace)
                    };
                    for item in items {
                        perform TerminalOutput.show(TerminalEvent.Project(item.workspace));
                        show(attempts, item);
                    }
                }
                commands_Command.New(title) => {
                    selected = history.create(options.workspace, title);
                    show(attempts, selected);
                }
                commands_Command.Resume(id) => {
                    let selection = match id {
                        Some(value) => SessionSelection.Exact(value),
                        None() => SessionSelection.Choose
                    };
                    match select(history, history, picker, options.workspace, selection, true, true) {
                        Some(value) => {
                            if value.workspace != options.workspace {
                                perform ProjectOperations.launch(
                                    LaunchRequest {
                                        workspace = value.workspace,
                                        arguments = ["--id", value.id]
                                    }
                                );
                            } else {
                                selected = value;
                                show(attempts, selected);
                            }
                        }
                        None() => (),
                    }
                }
                commands_Command.Rename(title) => {
                    history.rename(selected.id, title);
                    selected = history.load(selected.id);
                    show(attempts, selected);
                }
                commands_Command.Export(pathname) => perform TransferOperations.save(selected.id, pathname),
                commands_Command.Import(pathname) => {
                    selected = perform TransferOperations.load(options.workspace, pathname);
                    show(attempts, selected);
                }
                commands_Command.Copies => {
                    for job in perform TransferOperations.copies(options.workspace) {
                        perform TerminalOutput.show(TerminalEvent.Copy(job));
                    }
                }
                commands_Command.ResumeCopy(id) => {
                    let job = perform TransferOperations.job(id);
                    selected = if job.kind == "fork" {
                        perform TransferOperations.resume_fork(options.workspace, job.id)
                    } else {
                        perform TransferOperations.resume_import(options.workspace, job.id)
                    };
                    show(attempts, selected);
                }
                commands_Command.DiscardCopy(id) => {
                    perform TransferOperations.discard(options.workspace, id);
                    perform TerminalOutput.show(TerminalEvent.Message("[COPY   ] Unfinished copy discarded; original and retained copied records are preserved."));
                }
                commands_Command.Runs => {
                    for attempt in attempts.list(selected.id, false) {
                        perform TerminalOutput.show(TerminalEvent.Run(attempt));
                    }
                }
                commands_Command.ResolveRun(id, note) => {
                    let result = resolve(attempts, history, history, history, selected.id, id, note);
                    perform TerminalOutput.show(TerminalEvent.Resolved(result));
                }
                commands_Command.Compact => {
                    if ready_for_turn(attempts, selected.id) {
                        let settings = self.conversation.settings(selected.id, options.check);
                        if generation_supported(settings) {
                            self.conversation.compact(selected.id, settings);
                            perform TerminalOutput.show(TerminalEvent.Message("[CONTEXT] Summary saved; full original events retained."));
                        }
                    }
                },
                commands_Command.Config => {
                    let value = status(self.conversation.settings(selected.id, options.check));
                    perform TerminalOutput.show(TerminalEvent.Config(value));
                    perform TerminalOutput.show(TerminalEvent.Message("[CONFIG ] Context policy uses text estimates. Runtime token ceilings are static; command_timeout needs retained native jobs and is not active."));
                }
                commands_Command.Check => {
                    let settings = self.conversation.settings(selected.id, options.check);
                    let session = selected.id;
                    let value = handle checks_run() with {
                        SessionContext.current() => session;
                        SettingsContext.current() => settings;
                    };
                    perform TerminalOutput.show(TerminalEvent.Check(value));
                }
                commands_Command.Status => perform TerminalOutput.show(TerminalEvent.Status(history.load(selected.id))),
                commands_Command.Ask(value) => {
                    self.conversation.ask(selected.id, value, options.check);
                }
            }
        }
        return 0;
    }
}

public flow output<D ~ TerminalDisplay>(display: D) -> ![TerminalOutput => Console, Error<io_IOError>] ![] {
    return handler {
        TerminalOutput.show(event) => display.show(event);
    };
}
