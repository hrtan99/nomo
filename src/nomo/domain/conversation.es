module nomo.domain.conversation;

import nomo.domain.processes.ProcessWire;
import nomo.domain.attempts.wire_attempt;
import nomo.domain.wire.{value as json_value, fields};
import std.json.JsonValue;
import nomo.domain.attempts.ExecutionAttempt;
import nomo.domain.limits.history_bytes;
import nomo.domain.processes.{ArchivedProcessJob, ProcessJob};
import nomo.domain.settings.Settings;
import nomo.domain.workspace.ProjectInstruction;
import std.text.char_count;

public enum TraceRole {
    User,
    Assistant,
    Error,
    Model,
    Tool,
    Main,
    System,
    Other,
    MainToChild,
    MainToMain,
    ChildToMain
}
impl TraceRole {
    public flow wire(self) -> string ![] {
        return match self {
            TraceRole.User => "user",
            TraceRole.Assistant => "assistant",
            TraceRole.Error => "error",
            TraceRole.Model => "model",
            TraceRole.Tool => "tool",
            TraceRole.Main => "main",
            TraceRole.System => "system",
            TraceRole.Other => "other",
            TraceRole.MainToChild => "main -> child-1",
            TraceRole.MainToMain => "main -> main",
            TraceRole.ChildToMain => "child-1 -> main"
        };
    }

    public flow parse(raw: string) -> TraceRole ![] {
        return match raw {
            "user" => TraceRole.User,
            "assistant" => TraceRole.Assistant,
            "error" => TraceRole.Error,
            "model" => TraceRole.Model,
            "tool" => TraceRole.Tool,
            "main" => TraceRole.Main,
            "system" => TraceRole.System,
            "other" => TraceRole.Other,
            "main -> child-1" => TraceRole.MainToChild,
            "main -> main" => TraceRole.MainToMain,
            "child-1 -> main" => TraceRole.ChildToMain,
            _ => abort("invalid trace role")
        };
    }
}
public enum TraceKind {
    Answer,
    Applied,
    Approval,
    Check,
    Complete,
    Consume,
    Context,
    Delegate,
    Error,
    TraceEvent,
    Final,
    Input,
    NativeBudget,
    Notice,
    Plan,
    Request,
    Result,
    Text,
    Tool,
    WorkBoundary
}

impl TraceKind {
    public flow wire(self) -> string ![] {
        return match self {
            TraceKind.Answer => "answer",
            TraceKind.Applied => "applied",
            TraceKind.Approval => "approval",
            TraceKind.Check => "check",
            TraceKind.Complete => "complete",
            TraceKind.Consume => "consume",
            TraceKind.Context => "context",
            TraceKind.Delegate => "delegate",
            TraceKind.Error => "error",
            TraceKind.TraceEvent => "event",
            TraceKind.Final => "final",
            TraceKind.Input => "input",
            TraceKind.NativeBudget => "native-budget",
            TraceKind.Notice => "notice",
            TraceKind.Plan => "plan",
            TraceKind.Request => "request",
            TraceKind.Result => "result",
            TraceKind.Text => "text",
            TraceKind.Tool => "tool",
            TraceKind.WorkBoundary => "work-boundary"
        };
    }

    public flow parse(raw: string) -> TraceKind ![] {
        return match raw {
            "answer" => TraceKind.Answer,
            "applied" => TraceKind.Applied,
            "approval" => TraceKind.Approval,
            "check" => TraceKind.Check,
            "complete" => TraceKind.Complete,
            "consume" => TraceKind.Consume,
            "context" => TraceKind.Context,
            "delegate" => TraceKind.Delegate,
            "error" => TraceKind.Error,
            "event" => TraceKind.TraceEvent,
            "final" => TraceKind.Final,
            "input" => TraceKind.Input,
            "native-budget" => TraceKind.NativeBudget,
            "notice" => TraceKind.Notice,
            "plan" => TraceKind.Plan,
            "request" => TraceKind.Request,
            "result" => TraceKind.Result,
            "text" => TraceKind.Text,
            "tool" => TraceKind.Tool,
            "work-boundary" => TraceKind.WorkBoundary,
            _ => abort("invalid TraceKind spelling: " + raw)
        };
    }
}

public type TraceEvent = {
    role: TraceRole,
    kind: TraceKind,
    name: string,
    text: string
};

public type TraceState = {
    events: Array<TraceEvent>,
    characters: usize,
    spent: i32,
    stopped: bool
};

public type PendingRequest = {
    call: i64,
    name: string,
    complete: bool
};

// Native and imported conversation roles are an open protocol. Preserve every label verbatim;
// the closed Harness trace roles above do not constrain this history.
public type ChatMessage = {
    id: string,
    role: string,
    name: string,
    text: string
};

public enum SessionSelection {
    Current,
    Fresh,
    Existing,
    Exact(string),
    Choose
}

public enum EntryMode {
    Interactive,
    Attach
}

public type Options = {
    workspace: string,
    selection: SessionSelection,
    once: Option<string>,
    open_project: Option<string>,
    projects: bool,
    sessions: bool,
    all_sessions: bool,
    history: bool,
    status: bool,
    title: Option<string>,
    import_path: Option<string>,
    export_path: Option<string>,
    check: Option<Array<string>>
};

public flow offline(options: Options) -> bool {
    return options.projects || options.sessions || options.history || options.status
        || match options.export_path {
        Some(_) => true,
        None() => false
    };
}

// The application resolves the project/session; transport forwards this argv verbatim.
public flow forwarded(options: Options, selection: SessionSelection) -> Array<string> {
    var arguments: Array<string> = match selection {
        SessionSelection.Current => [],
        SessionSelection.Fresh => ["--new"],
        SessionSelection.Existing => ["--latest"],
        SessionSelection.Exact(id) => ["--id", id],
        SessionSelection.Choose => ["--resume"],
    };
    if options.projects {
        arguments = arguments.push("--projects");
    }
    if options.sessions {
        arguments = arguments.push("--sessions");
    }
    if options.all_sessions {
        arguments = arguments.push("--all");
    }
    if options.history {
        arguments = arguments.push("--history");
    }
    if options.status {
        arguments = arguments.push("--status");
    }
    match options.title {
        Some(value) => {
            arguments = arguments.extend(["--title", value]);
        }
        None() => (),
    }
    match options.import_path {
        Some(value) => {
            arguments = arguments.extend(["--import", value]);
        }
        None() => (),
    }
    match options.export_path {
        Some(value) => {
            arguments = arguments.extend(["--export", value]);
        }
        None() => (),
    }
    match options.once {
        Some(value) => {
            arguments = arguments.extend(["--once", value]);
        }
        None() => (),
    }
    match options.check {
        Some(value) => {
            arguments = arguments.push("--check").extend(value);
        }
        None() => (),
    }
    return arguments;
}

public flow fresh() -> TraceState {
    let events: Array<TraceEvent> = [];
    return TraceState {
        events,
        characters = 0,
        spent = 0,
        stopped = false
    };
}

// Always preserve one event and 64 characters for a capacity terminal error.
public flow capacity_error(state: TraceState, slots: usize, characters: usize) -> string {
    if state.events.len() + slots + 1 > 32 {
        return "history event capacity exhausted; start a new invocation";
    }
    if state.characters + characters + 64 > history_bytes() {
        return "history content capacity exhausted; start a new invocation";
    }
    return "";
}

public flow add(state: TraceState, event: TraceEvent) -> TraceState {
    return state {
        events = state.events.push(event),
        characters = state.characters + char_count(event.name) + char_count(event.text)
    };
}

public flow charge(state: TraceState) -> TraceState {
    return state {
        spent = state.spent + 1
    };
}

public flow stop(state: TraceState) -> TraceState {
    return state {
        stopped = true
    };
}

public type Answer = {
    text: string
};

public type Summary = {
    text: string
};

public type ModelTurn = {
    session: string,
    workspace: string,
    initial_request: string,
    request: string,
    summary: string,
    pending: string,
    history: Array<ChatMessage>,
    instructions: Array<ProjectInstruction>,
    runs: Array<ExecutionAttempt>,
    settings: Settings,
    jobs: Array<ProcessJob>,
    archived_jobs: Array<ArchivedProcessJob>
};

public type TextTurn = {
    state: TraceState,
    status: i32
};

public type ConversationLedger = {
    turns: i64,
    compactions: i64,
    tools: i64,
    generation_allowance: i64,
    context_bytes: usize
};

public type SavedSession = {
    id: string,
    workspace: string,
    title: string,
    next_event: i64,
    first_user: i64,
    summary_event: i64,
    summary_through: i64,
    pending: string,
    ledger: ConversationLedger
};

// Same lossless open-role contract as ChatMessage.
public type StoredEvent = {
    role: string,
    name: string,
    call: i64,
    chunks: usize,
    complete: bool
};

public flow wire_model_turn(input: ModelTurn) -> JsonValue ![] {
    return fields(
        json_value(input),
        [
            ("runs", JsonValue.Array(input.runs.iter().map(run => wire_attempt(run)).collect())),
            ("jobs", JsonValue.Array(input.jobs.iter().map(job => job.wire()).collect())),
            ("archived_jobs", JsonValue.Array(input.archived_jobs.iter().map(job => job.wire()).collect()))
        ]
    );
}

public flow wire_trace(input: TraceEvent) -> JsonValue ![] {
    return fields(
        json_value(input),
        [("role", JsonValue.String(input.role.wire())), ("kind", JsonValue.String(input.kind.wire()))]
    );
}

public flow wire_traces(input: Array<TraceEvent>) -> JsonValue ![] {
    return JsonValue.Array(input.iter().map(event => wire_trace(event)).collect());
}

public flow wire_state(input: TraceState) -> JsonValue ![] {
    return fields(json_value(input), [("events", wire_traces(input.events))]);
}
