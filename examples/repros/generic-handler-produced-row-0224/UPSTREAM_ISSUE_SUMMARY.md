## Diagnostic request (official 0.22.4)

A seven-source-file static reduction containing abstract application ports and a generic first-class Handler factory exits 1 with:

```text
error[effect::HandlerProducedEffectOutsideDeclaredRow]:
handler arm produced effects escape the declared produced row
```

The diagnostic points to `return handler { ... }` but does not identify the inferred produced row or the action not covered by its declared bound. This makes it difficult to distinguish an application contract omission from an inference defect.

The reduction contains no concrete spec implementations. The Handler captures four generic values constrained by specs; their methods have explicit rows involving Memory, Console, scoped Fs/Command actions and typed errors. It handles application actions plus a current-session action. Calls requiring the session are additionally enclosed in a local current-session handler. The factory has an explicit handled/produced Handler type and a pure construction row. Only source checking was performed.

## Scope and controls

- A single-source Console-only generic Handler factory checks successfully with this exact compiler/SDK, both with a concrete caller and with a generic caller. Generic first-class Handlers are therefore not universally broken.
- Removing only the produced bound in a separate diagnostic copy does not establish a fix: the CLI reports missing checked Handler rows at the consumer. No such change was adopted in the product.
- The exact cause of the richer failure remains unestablished. This report does **not** assert that the source needs no further contract or that every related diagnostic is a compiler bug.
- No model, native command, filesystem operation or credential was used. The richer application source is not included in this diagnostic-only report.
- This is distinct from the scoped-loop parser adoption blocker in #97 and from the older 0.13.5 imported-implementation diagnostic in #98.

Please include the inferred produced row and the uncovered effect/action in this diagnostic. Please also clarify whether generic spec-method calls inside a returned Handler require an additional bound beyond the explicit method rows and Handler produced row described above.

## Official graph

- CLI 0.22.4: `8f48d3fd855b4f712e209458047ea09b4316a198`
- Frontend: `3825cc9d1536a0998e2fbafab1f72a58c1676d63`
- Core/std: `099c0afa6ea91124512fdcca1a8880d67d4acb54`
- Interpreter: `ce296ac0872c427f420b2fef394101e0620f8c32`
- Unmodified official locked graph; Linux/aarch64; matching installed artifact SDK.
- Command: `etas --no-config --cache off check --all /workspace`
- Stdout: `checked 7 files`; exit 1. A checked-file count is not acceptance.

