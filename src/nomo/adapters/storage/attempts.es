module nomo.adapters.storage.attempts;

import std.memory.MemoryCursor;
import std.text.from_i64;
import nomo.domain.execution.attempt.Attempt;
import nomo.domain.execution.transitions.unresolved as is_unresolved;
import nomo.application.execution.ports.AttemptRepository;

alias Schema = MemoryRegion<{ Counter: Store<string, i64>, Attempts: Store<string, Attempt> }>;
public let Data = std.memory.region<Schema>(stable_id = "nomo-native-attempts-v1", store = "native-attempts");

public type NativeAttempts = {};

impl NativeAttempts ~ AttemptRepository {
    flow list(self, session: string, unresolved: bool) -> Array<Attempt> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        var result: Array<Attempt> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = Data.Attempts.page(cursor, 100);
            result = result.extend(page.entries.iter()
                .filter(item => item.value.session == session && (!unresolved || is_unresolved(item.value)))
                .map(item => item.value).collect());
            match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
        }
        return result;
    }
    flow load(self, id: string) -> Attempt {
        return match Data.Attempts.get(id) { Some(value) => value, None() => abort("native attempt not found"), };
    }
    flow prepare(self, session: string, kind: string, label: string, input_event: i64, through: i64) -> Attempt
        ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        let before = Data.Counter.get_entry("attempt");
        let number = match before { Some(value) => value.value, None() => 0 };
        match before {
            Some(value) => { Data.Counter.put_versioned("attempt", number + 1, value.version); }
            None() => { Data.Counter.insert("attempt", number + 1); }
        }
        let value = Attempt { id = session + "-run-" + from_i64(number), session, kind, label,
            phase = "prepared", input_event, through, result_event = -1, recovery_event = -1 };
        Data.Attempts.insert(value.id, value);
        return value;
    }
    flow update(self, id: string, phase: string, result_event: i64, recovery_event: i64) -> Attempt ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        let before = match Data.Attempts.get_entry(id) { Some(value) => value, None() => abort("native attempt not found"), };
        let old = before.value;
        let value = old { id, phase, result_event, recovery_event };
        Data.Attempts.put_versioned(id, value, before.version);
        return value;
    }
}
