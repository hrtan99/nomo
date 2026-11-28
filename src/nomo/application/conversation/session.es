module nomo.application.conversation.session;

import nomo.domain.attempts.AttemptKind;
import nomo.application.conversation.ports.{
    CodingModel,
    ContextProjection,
    ConversationCatalog,
    ConversationConfiguration,
    ConversationContext,
    ConversationModel,
    ConversationOutput,
    ConversationOutputSink,
    ConversationPicker,
    ConversationReader,
    ConversationService,
    ConversationWriter,
    GenerationReservation,
    ResultPublication,
    SavedJobsReader,
    SummaryModel
};
import nomo.application.editing.ports.ChangeOperations;
import nomo.application.execution.attempts.{begin, complete_attempt, dispatching, returned};
import nomo.application.execution.ports.{ArchivedJobCatalog, AttemptRepository, CommandOperations, ProcessOperations};
import nomo.application.resources.ProjectRoot;
import nomo.application.workspace.ports.{InstructionReader, WorkspaceObservations};
import nomo.domain.context.projection_project;
import nomo.domain.conversation.{ModelTurn, SavedSession, SessionSelection};
import nomo.domain.settings.{Settings, as_number, effective_window, estimated_tokens, recent_bytes, with_check};
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError};
import std.io.IOError;
import std.text.len;

public flow build<
    R ~ ConversationReader,
    I ~ InstructionReader,
    A ~ AttemptRepository,
    J ~ SavedJobsReader
        + ArchivedJobCatalog
>(history: R, instructions: I, attempts: A, jobs: J, session: string, request: string, settings: Settings) -> ModelTurn {
    let value = history.load(session);
    let initial = if value.first_user >= 0 {
        history.message(session, value.first_user).text
    } else {
        request
    };
    let summary = if value.summary_event >= 0 {
        history.message(session, value.summary_event).text
    } else {
        ""
    };
    let messages = history.messages(session, value.summary_through + 1);
    let guidance = instructions.read(".");
    let unresolved = attempts.list(session, true);
    let saved_jobs = jobs.read(session);
    return projection_project(
        ModelTurn {
            session,
            workspace = value.workspace,
            initial_request = initial,
            request,
            summary,
            pending = value.pending,
            history = messages,
            instructions = guidance,
            runs = unresolved,
            settings,
            jobs = saved_jobs,
            archived_jobs = jobs.archived_jobs(value.workspace)
        }
    );
}

public flow compact<
    R ~ ConversationReader,
    G ~ GenerationReservation,
    A ~ AttemptRepository,
    P ~ ResultPublication,
    C ~ ContextProjection
>(archive: R, generation: G, attempts: A, publication: P, projection: C, session: string, settings: Settings) -> unit {
    let before = archive.load(session);
    let input = perform ConversationContext.acquire(session, "", settings);
    generation.reserve(session, true, projection.bytes(input));
    var index = before.next_event - 1;
    var first = before.next_event;
    var retained: usize = 0;
    var count: i64 = 0;
    let allowance = recent_bytes(settings);
    @limits([Iterations(2147483647)]) while index >= 0 && count < settings.keep_messages {
        let bytes = len(archive.message(session, index).text);
        if bytes > allowance - retained {
            break;
        }
        retained = retained + bytes;
        first = index;
        count = count + 1;
        index = index - 1;
    }
    let through = first - 1;
    let attempt = begin(
        attempts,
        session,
        AttemptKind.Summary,
        "CompactHistory",
        before.next_event - 1,
        through
    );
    dispatching(attempts, attempt.id);
    let summary = perform ConversationModel.summarize(input);
    returned(attempts, publication, attempt.id, "summary", "context_summary", summary.text, -1);
    complete_attempt(attempts, publication, archive, attempt.id);
}

// Dependencies are resolved at construction. Session/settings stay local to each call.
public type Conversation<
    History ~ ConversationReader + ConversationWriter + GenerationReservation
        + ResultPublication,
    Attempts ~ AttemptRepository,
    Instructions ~ InstructionReader,
    Jobs ~ SavedJobsReader
        + ArchivedJobCatalog,
    Coding ~ CodingModel,
    Summary ~ SummaryModel,
    Projection ~ ContextProjection,
    Configuration ~ ConversationConfiguration,
    Output ~ ConversationOutputSink
> = {
    @inject history: History,
    @inject attempts: Attempts,
    @inject instructions: Instructions,
    @inject jobs: Jobs,
    @inject coding: Coding,
    @inject summary: Summary,
    @inject projection: Projection,
    @inject configuration: Configuration,
    @inject output: Output,
};

impl Conversation<
    History ~ ConversationReader + ConversationWriter + GenerationReservation
        + ResultPublication,
    Attempts ~ AttemptRepository,
    Instructions ~ InstructionReader,
    Jobs ~ SavedJobsReader
        + ArchivedJobCatalog,
    Coding ~ CodingModel,
    Summary ~ SummaryModel,
    Projection ~ ContextProjection,
    Configuration ~ ConversationConfiguration,
    Output ~ ConversationOutputSink
> ~ ConversationService {
    public flow settings(self, session: string, check: Option<Array<string>>) -> Settings
    ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<BudgetExceeded>
    ] {
        let value = self.configuration.load(session);
        return with_check(value, check);
    }

    public flow ask(self, session: string, request: string, check: Option<Array<string>>) -> bool
    ![
        Agentic,
        CommandOperations,
        WorkspaceObservations,
        ChangeOperations,
        ProcessOperations,
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
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<IOError>,
        Error<BudgetExceeded>
    ] {
        let dependencies = self;
        return turn(
            dependencies.history,
            dependencies.history,
            dependencies.history,
            dependencies.attempts,
            dependencies.history,
            dependencies.projection,
            session,
            request
        ) with {
            ConversationContext.settings(selected) => self.settings(selected, check);
            ConversationContext.acquire(selected, task, settings) => build(
                dependencies.history,
                dependencies.instructions,
                dependencies.attempts,
                dependencies.jobs,
                selected,
                task,
                settings
            );
            ConversationModel.code(input) => dependencies.coding.code(input);
            ConversationModel.summarize(input) => dependencies.summary.summarize(input);
            ConversationOutput.write(line) => dependencies.output.write(line);
        };
    }

    public flow compact(self, session: string, settings: Settings) -> unit
    ![
        Agentic,
        Memory,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<BudgetExceeded>
    ] {
        let dependencies = self;
        compact(
            dependencies.history,
            dependencies.history,
            dependencies.attempts,
            dependencies.history,
            dependencies.projection,
            session,
            settings
        ) with {
            ConversationContext.acquire(selected, task, configuration) => build(
                dependencies.history,
                dependencies.instructions,
                dependencies.attempts,
                dependencies.jobs,
                selected,
                task,
                configuration
            );
            ConversationModel.summarize(input) => dependencies.summary.summarize(input);
        };
    }
}

flow existing<R ~ ConversationReader, C ~ ConversationCatalog>(
    reader: R,
    catalog: C,
    workspace: string,
    id: string,
    activate: bool
) -> SavedSession {
    let value = reader.load(id);
    // A foreign project is routed before its files, tools or selection are used.
    if activate && value.workspace == workspace {
        return catalog.select(workspace, id);
    }
    return value;
}

public flow select<R ~ ConversationReader, C ~ ConversationCatalog, P ~ ConversationPicker>(
    reader: R,
    catalog: C,
    picker: P,
    workspace: string,
    selection: SessionSelection,
    activate: bool,
    all_sessions: bool
) -> Option<SavedSession> {
    return match selection {
        SessionSelection.Fresh => Some(catalog.create(workspace, "New conversation")),
        SessionSelection.Exact(id) => Some(existing(reader, catalog, workspace, id, activate)),
        SessionSelection.Choose => match picker.choose(if all_sessions {
            catalog.all_sessions()
        } else {
            catalog.sessions(workspace)
        }) {
            Some(id) => Some(existing(reader, catalog, workspace, id, activate)),
            None() => None()
        },
        SessionSelection.Current => match catalog.selected(workspace) {
            Some(id) => Some(existing(reader, catalog, workspace, id, activate)),
            None() => Some(catalog.create(workspace, "New conversation"))
        },
        SessionSelection.Existing => match catalog.selected(workspace) {
            Some(id) => Some(existing(reader, catalog, workspace, id, activate)),
            None() => abort("no saved conversation is selected for this project"),
        }
    };
}

public flow ready<R ~ AttemptRepository>(repository: R, session: string) -> bool {
    return match repository.list(session, true).iter().find(
        value => value.kind == AttemptKind.Coding
            || value.kind == AttemptKind.Summary
    ) {
        Some(value) => {
            perform ConversationOutput.write(
                "[RUN    ] " + value.id
                    + " has no recorded completion. Inspect /runs; /resolve-run ID NOTE records your recovery decision. This prompt was not submitted."
            );
            false
        }
        None() => true
    };
}

public flow supported(settings: Settings) -> bool {
    if settings.max_output_tokens != 131072 {
        perform ConversationOutput.write("[CONFIG ] This native runtime has a static 131072 output cap. The requested max_output_tokens needs an upstream per-call limit API; no model request was submitted.");
        return false;
    }
    return true;
}

public flow turn<
    R ~ ConversationReader,
    W ~ ConversationWriter,
    G ~ GenerationReservation,
    A ~ AttemptRepository,
    P ~ ResultPublication,
    C ~ ContextProjection
>(
    archive: R,
    writer: W,
    generation: G,
    attempts: A,
    publication: P,
    projection: C,
    session: string,
    request: string
) -> bool {
    if !ready(attempts, session) {
        return false;
    }
    let request_event = writer.append(session, "user", "", request, -1);
    let settings = perform ConversationContext.settings(session);
    if !supported(settings) {
        return false;
    }
    var input = perform ConversationContext.acquire(session, request, settings);
    if projection.needs_compaction(input) {
        perform ConversationOutput.write("[CONTEXT] Summarizing; complete original history stays saved.");
        compact(archive, generation, attempts, publication, projection, session, settings);
        input = perform ConversationContext.acquire(session, request, settings);
    }
    if estimated_tokens(projection.bytes(input)) > as_number(effective_window(settings) - settings.max_output_tokens) {
        perform ConversationOutput.write("[CONTEXT] Saved summary and retained input still exceed the configured context estimate. No coding model request was submitted; complete original history remains saved.");
        return false;
    }
    generation.reserve(session, false, projection.bytes(input));
    let attempt = begin(
        attempts,
        session,
        AttemptKind.Coding,
        "NativeCoding",
        request_event,
        archive.load(session).next_event - 1
    );
    dispatching(attempts, attempt.id);
    let answer = perform ConversationModel.code(input);
    returned(attempts, publication, attempt.id, "assistant", "", answer.text, request_event);
    complete_attempt(attempts, publication, archive, attempt.id);
    perform ConversationOutput.write(answer.text);
    return true;
}
