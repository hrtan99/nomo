module nomo.application.migration.project_state;

import std.effects.Fs;
import std.fs.{IOError as FileError, ReadLimitError};
import std.text.{strip_prefix, parse_i64, from_i64, from_usize};
import nomo.application.migration.ports.{ProjectStateSource, NativeStateDestination, HistoricalEvents, MigrationRoot};
import nomo.application.conversation.ports.ResultPublication;
import nomo.domain.migration.native_state.{NativeRecord, MigrationReport};
import nomo.domain.conversation.session.{Session, Ledger};
import nomo.domain.migration.project_state.{ProjectEvent, ProjectEdit, edit_phases};
import nomo.domain.mutations.models.{Journal, Step};

flow migrate_edit<D ~ NativeStateDestination, E ~ HistoricalEvents>(edit: ProjectEdit, destination: D, events: E) -> unit
    ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let call = events.append(edit.session, "archive", "migrated_project_edit", edit.archive);
    let (phase, step_phase) = edit_phases(edit.phase);
    var steps: i64 = 0;
    for saved in edit.paths {
        destination.insert(NativeRecord.Step(edit.id + "/" + from_i64(steps), Step { phase = step_phase, paths = [saved] }));
        steps = steps + 1;
    }
    destination.insert(NativeRecord.Journal(edit.id, Journal { id = edit.id, session = edit.session,
        name = "migrated_project_edit", call, phase, steps,
        message = "Imported old project journal. Directory modes, timestamps, links and per-step dispatch were not recorded by the source format.",
        owner_call = call, owner_name = "migrated_project_edit" }));
}

flow role(event: ProjectEvent) -> string {
    // Match the shipping projection: compactions and duplicate answer actions
    // remain in the archive but do not become model-context messages.
    return if event.kind == "compaction" { "summary" }
        else if event.kind == "action" && event.name == "answer" { "archive" }
        else { event.role };
}

public flow migrate<S ~ ProjectStateSource, D ~ NativeStateDestination, E ~ HistoricalEvents, P ~ ResultPublication>(
    source: S, destination: D, events: E, publication: P
) -> MigrationReport
    ![Fs.read<MigrationRoot>, Memory, Error<FileError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let image = source.load();
    var rows: usize = 0;
    var next_id: i64 = 0;
    var selected: Array<string> = [];
    var projects = image.projects;
    for old in image.conversations {
        let ledger = Ledger { turns = 0, compactions = 0, tools = 0, generation_allowance = 0, context_bytes = 0 };
        destination.insert(NativeRecord.Session(old.id, Session { id = old.id, workspace = old.workspace,
            title = old.title, next_event = 0, first_user = -1, summary_event = -1, summary_through = -1, pending = "", ledger }));
        events.append(old.id, "archive", "migrated_project_source", old.archive);
        var through: i64 = 0;
        for event in old.events {
            let index = events.append(old.id, role(event), event.name, event.text);
            if event.id <= old.compacted_through { through = index; }
            rows = rows + 1;
        }
        for edit in image.edits {
            if edit.session == old.id && edit.workspace == old.workspace {
                migrate_edit(edit, destination, events);
                rows = rows + 1;
            }
        }
        if old.summary != "" {
            let index = events.append(old.id, "summary", "context_summary", old.summary);
            publication.select_summary(old.id, index, through);
        }
        if !selected.iter().any(workspace => workspace == old.workspace) {
            destination.insert(NativeRecord.Selected(old.workspace, old.id));
            selected = selected.push(old.workspace);
        }
        if !projects.iter().any(workspace => workspace == old.workspace) { projects = projects.push(old.workspace); }
        match strip_prefix(old.id, "native-") {
            Some(suffix) => match parse_i64(suffix) {
                Ok(number) => { if number >= next_id { next_id = number + 1; } }
                Err(_) => (),
            },
            None() => (),
        }
        rows = rows + 1;
    }
    for job in image.jobs {
        destination.insert(NativeRecord.ArchivedJob(job.record.id, job.record));
        var part: usize = 0;
        for data in job.chunks {
            destination.insert(NativeRecord.ArchivedPart(job.record.id + "/" + from_usize(part), data));
            part = part + 1;
        }
        if !projects.iter().any(workspace => workspace == job.record.workspace) { projects = projects.push(job.record.workspace); }
        rows = rows + 1;
    }
    destination.insert(NativeRecord.Counter("session", next_id));
    destination.insert(NativeRecord.Projects("folders", projects));
    return MigrationReport { source_sha256 = image.source_sha256, rows };
}
