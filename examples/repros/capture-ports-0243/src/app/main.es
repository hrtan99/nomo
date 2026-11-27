module app.main;

import std.task.{run, start, await};
import std.task.scheduler.SchedulerHandle;

effect Registered<T> { action put(value: T) -> unit; }

flow publish<T>(value: T) -> unit ![Registered<T>] {
    perform Registered<T>.put(value);
}

spec Reader { flow read(self) -> i32 ![]; }
type Constant = {};
impl Constant ~ Reader { flow read(self) -> i32 ![] { return 7; } }

flow collect<R ~ Reader>(reader: R) -> i32 ![] { return reader.read(); }

flow scoped<R ~ Reader>(reader: R) -> i32 ![] {
    return run((scheduler: SchedulerHandle) => {
        let child = start(() => collect(reader));
        return await(child);
    });
}

public flow main(args: Array<string>) -> i32 ![] {
    publish<i32>(7) with { Registered<i32>.put(value) => (); };
    return scoped(Constant {});
}
