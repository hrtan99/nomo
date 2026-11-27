module nomo.adapters.storage.change_journals;

import std.memory.MemoryCursor;
import nomo.native.mutations.Data;
import nomo.domain.mutations.models.{Journal, Step};
import nomo.application.mutations.ports.ChangeJournalStore;

public type NativeChangeJournals = {};
impl NativeChangeJournals ~ ChangeJournalStore {
    flow lookup(self, id: string) -> Option<Journal> ![Memory, Error<StorageError>] { return Data.Journals.get(id); }
    flow insert(self, value: Journal) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Journals.insert(value.id, value); }
    flow save(self, value: Journal) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Journals.put(value.id, value); }
    flow step(self, key: string) -> Option<Step> ![Memory, Error<StorageError>] { return Data.Steps.get(key); }
    flow save_step(self, key: string, value: Step) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Steps.put(key, value); }
    flow list(self, session: string) -> Array<Journal> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        var result: Array<Journal> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = Data.Journals.page(cursor, 100);
            result = result.extend(page.entries.iter()
                .filter(item => item.value.session == session)
                .map(item => item.value).collect());
            match page.cursor { Some(next) => { cursor = Some(next); } None() => { break; } }
        }
        return result;
    }
}
