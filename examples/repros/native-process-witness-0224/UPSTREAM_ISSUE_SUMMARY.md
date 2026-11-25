## Observed compiler failure

An isolated six-source-file process-adapter package checked with official CLI 0.22.4 and its matching artifact SDK exits 4, with no source diagnostic or checked-file count:

```text
frontend session failed: Pipeline("native invocation has no checked implementation witness")
```

Command: `etas --no-config --cache off check --all /workspace`.

The package contains process request/event records, pure byte-to-display conversion, an application `ProcessControl<Live>` spec, a concrete implementation using `Live = std.host.command.CommandHandle`, a scoped Region declaration and a generic source-check consumer. Methods have explicit effect rows. The adapter uses the matching SDK's `Command.new(...).with_cwd(...)`, `start`, `reconnect`, and `CommandHandle.id/read/write/close_stdin/stop` APIs. For example, the start body contains:

```etas
let process = start(HostCommand.new(program, arguments).with_cwd(root), DefaultCommandSandbox);
return process.id();
```

Only `check` was invoked. No process was started, no model request was sent and no credential was involved. The exact native invocation that triggers the Pipeline error has not yet been identified. The richer application source is not included in this diagnostic-only report.

## Expected diagnostic contract

The compiler should either check the adapter or provide an actionable source-contract diagnostic. If a native invocation lacks required callable/spec evidence, please identify that invocation and the missing contract. A raw Pipeline error with no source location is insufficient to determine whether the application needs another declaration or the SDK witness is incomplete.

This does not assert that every application declaration is valid or identify a root cause. It is independent of the scoped-loop parser error (#97), the older imported-implementation report (#98), and the returned Handler diagnostic (#99). No loop annotation or Handler factory is involved in this reduced check.

## Official graph and environment

- CLI 0.22.4: `8f48d3fd855b4f712e209458047ea09b4316a198`
- Frontend: `3825cc9d1536a0998e2fbafab1f72a58c1676d63`
- Core/std: `099c0afa6ea91124512fdcca1a8880d67d4acb54`
- Interpreter: `ce296ac0872c427f420b2fef394101e0620f8c32`
- Official locked graph, unmodified source and default features; Linux/aarch64; standard dev build.
- CLI binary SHA-256: `1037eda142e287257485e38cd0a86f487042ea4a4aa6e9e1943f79eb2e38e3da`
- Matching installed SDK: `etas-0.7.0-aarch64-unknown-linux-gnu-c2620b315312`; frontend 0.19.3; body schema 93; metadata schema 76.
- SDK manifest SHA-256: `ed146d0f0aa8545138dc97c3e1a309e2f3c48d5aeb30584d7491a686f5d03f00`
