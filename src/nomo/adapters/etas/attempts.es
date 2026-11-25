module nomo.adapters.etas.attempts;

import std.memory.{get_entry, MemoryCursor};
import std.text.from_i64;
import nomo.native.lifecycle.Attempt;
import nomo.domain.execution.transitions.unresolved as is_unresolved;
import nomo.application.native.execution.ports.AttemptRepository;

alias Schema = MemoryRegion<{ Counter: Store<string, i64>, Attempts: Store<string, Attempt> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-attempts-v1", store = "native-attempts");

public type NativeAttempts = {};

impl NativeAttempts ~ AttemptRepository {
    flow list(self, session: string, unresolved: bool) -> Array<Attempt> ![Memory, Error<StorageError>] {
        var result: Array<Attempt> = [];
        var cursor: Option<MemoryCursor> = None();
        while true limit Iterations(2147483647) {
            let page = Data.Attempts.page(cursor, 100);
            for item in page.entries limit Iterations(2147483647) {
                let value = item.value;
                if value.session == session && (!unresolved || is_unresolved(value)) {
                    result = result.push(value);
                }
            }
            match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
        }
        return result;
    }
    flow load(self, id: string) -> Attempt {
        return match Data.Attempts.get(id) { Some(value) => value, None() => { abort("native attempt not found"); } };
    }
    flow prepare(self, session: string, kind: string, label: string, input_event: i64, through: i64) -> Attempt
        ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        let before = get_entry(Data.Counter, "attempt");
        let number = match before { Some(value) => value.value, None() => 0 };
        match before {
            Some(value) => { Data.Counter.put_versioned("attempt", number + 1, value.version); }
            None() => { Data.Counter.insert("attempt", number + 1); }
        }
        let value = Attempt { id = session + "-run-" + from_i64(number), session = session, kind = kind, label = label,
            phase = "prepared", input_event = input_event, through = through, result_event = -1, recovery_event = -1 };
        Data.Attempts.insert(value.id, value);
        return value;
    }
    flow update(self, id: string, phase: string, result_event: i64, recovery_event: i64) -> Attempt {
        let before = match get_entry(Data.Attempts, id) { Some(value) => value, None() => { abort("native attempt not found"); } };
        let old = before.value;
        let value = Attempt { id = id, session = old.session, kind = old.kind, label = old.label, phase = phase,
            input_event = old.input_event, through = old.through, result_event = result_event, recovery_event = recovery_event };
        Data.Attempts.put_versioned(id, value, before.version);
        return value;
    }
}
