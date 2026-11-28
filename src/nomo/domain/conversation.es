module nomo.domain.conversation;

import nomo.core.conversation.{Event, State};
import nomo.domain.limits.history_bytes;
import nomo.domain.processes.ArchivedJob;
import nomo.domain.settings.Settings;
import nomo.domain.workspace.ProjectInstruction;
import nomo.native.history.{Ledger, Session};
import nomo.native.lifecycle.Attempt;
import nomo.native.processes.Job;
import std.text.char_count;

public type PendingRequest = { call: i64, name: string, complete: bool };

public type ChatMessage = { id: string, role: string, name: string, text: string };

public enum SessionSelection { Current, Fresh, Existing, Exact(string), Choose }

public enum EntryMode { Interactive, Attach }

public type Options = { workspace: string, selection: SessionSelection, once: Option<string>,
    open_project: Option<string>, projects: bool, sessions: bool, all_sessions: bool,
    history: bool, status: bool, title: Option<string>, import_path: Option<string>,
    export_path: Option<string>, check: Option<Array<string>> };

public flow offline(options: Options) -> bool {
    return options.projects || options.sessions || options.history || options.status ||
        match options.export_path { Some(_) => true, None() => false };
}

// The application resolves the project/session; transport forwards this argv verbatim.
public flow forwarded(options: Options, selection: SessionSelection) -> Array<string> {
    var arguments: Array<string> = match selection {
        SessionSelection.Current => [], SessionSelection.Fresh => ["--new"],
        SessionSelection.Existing => ["--latest"], SessionSelection.Exact(id) => ["--id", id],
        SessionSelection.Choose => ["--resume"],
    };
    if options.projects { arguments = arguments.push("--projects"); }
    if options.sessions { arguments = arguments.push("--sessions"); }
    if options.all_sessions { arguments = arguments.push("--all"); }
    if options.history { arguments = arguments.push("--history"); }
    if options.status { arguments = arguments.push("--status"); }
    match options.title { Some(value) => { arguments = arguments.extend(["--title", value]); } None() => (), }
    match options.import_path { Some(value) => { arguments = arguments.extend(["--import", value]); } None() => (), }
    match options.export_path { Some(value) => { arguments = arguments.extend(["--export", value]); } None() => (), }
    match options.once { Some(value) => { arguments = arguments.extend(["--once", value]); } None() => (), }
    match options.check { Some(value) => { arguments = arguments.push("--check").extend(value); } None() => (), }
    return arguments;
}

public flow fresh() -> State {
    let events: Array<Event> = [];
    return State { events, characters = 0, spent = 0, stopped = false };
}

// Always preserve one event and 64 characters for a capacity terminal error.
public flow capacity_error(state: State, slots: usize, characters: usize) -> string {
    if state.events.len() + slots + 1 > 32 { return "history event capacity exhausted; start a new invocation"; }
    if state.characters + characters + 64 > history_bytes() { return "history content capacity exhausted; start a new invocation"; }
    return "";
}

public flow add(state: State, event: Event) -> State {
    return state { events = state.events.push(event), characters = state.characters + char_count(event.name) + char_count(event.text) };
}

public flow charge(state: State) -> State {
    return state { spent = state.spent + 1 };
}

public flow stop(state: State) -> State {
    return state { stopped = true };
}

public type Answer = { text: string };

public type Summary = { text: string };

public type ModelTurn = { session: string, workspace: string, initial_request: string, request: string, summary: string, pending: string, history: Array<ChatMessage>, instructions: Array<ProjectInstruction>, runs: Array<Attempt>, settings: Settings, jobs: Array<Job>, archived_jobs: Array<ArchivedJob> };

public type TextTurn = { state: State, status: i32 };
