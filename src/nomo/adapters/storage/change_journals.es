module nomo.adapters.storage.change_journals;

import std.memory.MemoryCursor;
import nomo.native.mutations.{Data, Journal as StoredJournal, Step as StoredStep, SavedPath as StoredPath};
import nomo.domain.mutations.models.{Journal, Step, SavedPath};
import nomo.application.mutations.ports.ChangeJournalStore;

flow view(value: StoredJournal) -> Journal {
    return Journal { id = value.id, session = value.session, name = value.name, call = value.call, phase = value.phase, steps = value.steps, message = value.message, owner_call = value.owner_call, owner_name = value.owner_name };
}
flow stored(value: Journal) -> StoredJournal {
    return StoredJournal { id = value.id, session = value.session, name = value.name, call = value.call, phase = value.phase, steps = value.steps, message = value.message, owner_call = value.owner_call, owner_name = value.owner_name };
}
flow path_view(value: StoredPath) -> SavedPath {
    return SavedPath { path = value.path, before_exists = value.before_exists, before = value.before, after_exists = value.after_exists, after = value.after };
}
flow stored_path(value: SavedPath) -> StoredPath {
    return StoredPath { path = value.path, before_exists = value.before_exists, before = value.before, after_exists = value.after_exists, after = value.after };
}
flow step_view(value: StoredStep) -> Step {
    let paths = value.paths.iter().map(item => path_view(item)).collect();
    return Step { phase = value.phase, paths };
}
flow stored_step(value: Step) -> StoredStep {
    let paths = value.paths.iter().map(item => stored_path(item)).collect();
    return StoredStep { phase = value.phase, paths };
}

public type NativeChangeJournals = {};
impl NativeChangeJournals ~ ChangeJournalStore {
    flow lookup(self, id: string) -> Option<Journal> ![Memory, Error<StorageError>] { return match Data.Journals.get(id) { Some(value) => Some(view(value)), None() => None() }; }
    flow insert(self, value: Journal) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Journals.insert(value.id, stored(value)); }
    flow save(self, value: Journal) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Journals.put(value.id, stored(value)); }
    flow step(self, key: string) -> Option<Step> ![Memory, Error<StorageError>] { return match Data.Steps.get(key) { Some(value) => Some(step_view(value)), None() => None() }; }
    flow save_step(self, key: string, value: Step) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Steps.put(key, stored_step(value)); }
    flow list(self, session: string) -> Array<Journal> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        var result: Array<Journal> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = Data.Journals.page(cursor, 100);
            result = result.extend(page.entries.iter()
                .filter(item => item.value.session == session)
                .map(item => view(item.value)).collect());
            match page.cursor { Some(next) => { cursor = Some(next); } None() => { break; } }
        }
        return result;
    }
}
