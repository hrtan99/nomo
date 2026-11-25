## Observed behavior

The official CLI 0.22.4 rejects the loop resource annotation required by its matching design specification. The annotation is on its own line, immediately before a `for` loop:

```etas
module app.main;

flow main(args: Array<string>) -> i32 {
    var total = 0;
    @limits([Iterations(3)])
    for value in [1, 2, 3] {
        total = total + value;
    }
    return total;
}
```

Dependency-free package:

```toml
[package]
name = "scoped-loop-limits"
version = "0.1.0"
edition = "2026"

[source]
root = "src"

[[bin]]
name = "scoped-loop-limits"
module = "app.main"
flow = "main"
```

Save the source as `src/app/main.es`, run `etas --no-config --cache off pkg lock .`, then `etas --no-config --cache off check --all .`. Lock succeeds; check exits 1:

```text
error[syntax::InvalidExpression]: expected expression
 --> /repro/src/app/main.es:5:5
  |     @limits([Iterations(3)])
  |     ^ expected expression
```

The following return/closing brace also produce recovery diagnostics. No model, Host action, real credential or network request is involved.

## Expected contract

The [matching design specification](https://github.com/etas-project/etas/blob/8f48d3fd855b4f712e209458047ea09b4316a198/docs/design/04-flows-human-gates-and-protocols.md#14-resource-contracts-and-budgeted-loops) explicitly describes `@limits([Iterations(...)])` on for/while/retry scopes, evaluation before entering the scope, and a runtime iteration bound across all entries. It says the old postfix limit clause is no longer syntax.

The example should check successfully and preserve the declared iteration bound. The previous postfix form is also rejected on this graph, so it does not provide a supported migration path.

## Official graph and installation

- CLI: `8f48d3fd855b4f712e209458047ea09b4316a198` (0.22.4)
- Core/std: `099c0afa6ea91124512fdcca1a8880d67d4acb54`
- Frontend: `3825cc9d1536a0998e2fbafab1f72a58c1676d63`
- Interpreter: `ce296ac0872c427f420b2fef394101e0620f8c32`
- Official CLI Cargo.lock SHA-256: `0527ff5b5e7a70a00116b652aca6c7edd96deb8115d3e9a6094ae62429b2d1bf`
- Linux/aarch64; Rust 1.93.1; unmodified official source; standard Cargo dev profile, locked graph, default features; no source/dependency overrides.
- CLI binary SHA-256: `1037eda142e287257485e38cd0a86f487042ea4a4aa6e9e1943f79eb2e38e3da`
- Matching SDK installed by the official `etas std install --prefix` command, default artifact provider.
- SDK manifest SHA-256: `ed146d0f0aa8545138dc97c3e1a309e2f3c48d5aeb30584d7491a686f5d03f00`
- SDK toolchain: `etas-0.7.0-aarch64-unknown-linux-gnu-c2620b315312`; frontend version 0.19.3; body schema 93; metadata schema 76.
- The official constructor-injection records example runs successfully with this same installed CLI/SDK (completed, i32 0).

## Implementation observation and impact

The pinned [block statement parser](https://github.com/etas-project/etas-frontend/blob/3825cc9d1536a0998e2fbafab1f72a58c1676d63/crates/etas_syntax/src/grammar/stmt.rs#L75) dispatches statement keywords or expressions and has no annotation entry path. Its [for/while parsers](https://github.com/etas-project/etas-frontend/blob/3825cc9d1536a0998e2fbafab1f72a58c1676d63/crates/etas_syntax/src/grammar/stmt.rs#L380) parse only the iterable/condition and body. This is consistent with the observed diagnostic; the independently executed reproduction above is for `for` only.

This prevents migration of existing explicitly bounded application loops while preserving their runtime contracts. Please implement the documented scoped annotation and enforcement across the frontend/runtime, or identify the supported syntax that retains the same loop lifetime and bound. Removing existing bounds is not a semantics-preserving application migration.
