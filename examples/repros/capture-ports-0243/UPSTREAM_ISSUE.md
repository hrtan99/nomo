## Official 0.24.3 check rejects two legal generic composition patterns

This one-module positive program uses only the official standard library. No Nomo import, Memory, file, command, model, external request or private data is involved. It demonstrates two distinct diagnostic observations; no shared root cause is claimed.

```etas
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
```

Run: `etas --no-config --cache off check --all --format json .`

Observed exit 1 in 0.50 s:

1. At `run` in `scoped`: `effect::IncompleteEffectFacts: external call effect selector specialization failed: checked latent flow summary is missing for parameter read`.
2. At `publish`, despite its declared `![Registered<T>]`: `effect::EffectOutsideDeclaredRow: inferred effect Registered.put escapes the declared effect row`, followed by `effect::EscapedEffect` for the same requested action. The concrete caller installs `Registered<i32>.put`.

Expected: the declared generic effect instance covers its own action; Task captures the actual `reader` argument and its `Reader.read` implementation. The source should check, or report an identifiable source-contract violation if either pattern is unsupported. The type and effect forms follow the official parameterized `Inject<T>`/`Error<E>` declarations and Task's generic callback contract.

A full IoC consumer first exposed the same missing `read` latent fact at its Task start, plus a captured-callable free-parameter fact and the analogous declared registration-effect escape. The independent program above establishes a compiler observation without those application dependencies. It does not identify the cause of the additional full-consumer diagnostic. Runtime capture was not executed because the ordinary check failed. No specializations, type anchors, alternate callback path, compiler patch or guard override were installed.

Exact unmodified release graph:
- CLI dd5768dc871b99fb4cc06c4532c772e257d2f64b (0.24.3)
- Core 377875e8afb201a782e054b313fe7e529bcaa485
- Frontend bfe255314bc142fdd79a7c5d3d7f0cc77988574e
- Interpreter 5dfc2a121efb326107d461e08e66b31499db143b
- Standard release binary SHA-256 a172dd7a35541f91ebaa0fb4462f462fe76374bc8d3ffa6f2237a87e76d7d8f2
- Matching SDK compiler 0.21.3, body 98, metadata 78; std artifact blake3:d8d154d5d1d2820c9b26bb62c6a5ebb74d138accaa930a363f15f7de5be135e2.

Linux/aarch64; cache off; no source overrides, compiler patches or custom Rust flags. The reduction and exact JSON diagnostics are retained under `examples/repros/capture-ports-0243` in hrtan99/nomo's review branch.
