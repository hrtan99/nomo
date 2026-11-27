Published: https://github.com/etas-project/etas-frontend/issues/105

## Observed on the unmodified official CLI 0.24.6 graph

The following positive, one-module program imports the official `std.effects.Inject`, declares a tool parameter injected as an existential behavioral spec, and installs a matching named provider around the agent call. Ordinary source checking rejects `Inject<? ~ Changes>` as an unknown effect tag and subsequently reports `std.effects.Inject.get` as escaping the provider scope.

This is an independently reduced observation from a Nomo IoC consumer, not an identified root cause. No shared cause with frontend #103 or interpreter #123 is claimed. The initial reduction had a separate owned Prompt.user type error; it was corrected to the existing Trusted system constructor before the diagnostic reported here.

```etas
module app.main;

import std.effects.Inject;

spec Changes { flow apply(self, text: string) -> string ![]; }
type LocalChanges = {};
impl LocalChanges ~ Changes {
    flow apply(self, text: string) -> string ![] { return text; }
}

public tool apply(text: string, @inject changes: ? ~ Changes) -> string
    ![Inject<? ~ Changes>] {
    return changes.apply(text);
}

@tools([apply])
agent Coder = {};
impl Coder {
    public flow run(self) -> string ![Inject<? ~ Changes>] {
        return perform infer<string>(Prompt.new().system(Trusted("Synthetic injection example")));
    }
}

public flow main(args: Array<string>) -> i32 ![Agentic] {
    let changes: ? ~ Changes = LocalChanges {};
    let answer = (Coder {}).run() with { changes: ? ~ Changes => changes; };
    return 0;
}

```

Command: `etas --no-config --cache off check --all --format json .`

Actual: exit 1 in 0.155 s, after type checking:

- `effect::UnknownEffectTag` at the tool and agent method: “effect tag is not known to the current effect registry”.
- `effect::EffectOutsideDeclaredRow` at main: “inferred effect std.effects.Inject.get escapes the declared effect row”.
- `effect::EscapedEffect` at main: “requested action std.effects.Inject.get is not handled by a scoped or default handler and is outside the declared effect row”.
- The UnknownEffectTag observations are duplicated in the JSON output (six diagnostics total).

Expected: the documented Inject<T> effect selector should resolve through its explicit import, the model-facing ordinary argument is only `text`, and the scoped provider should cover the generated omitted-parameter request. If the declaration of this boundary is incorrect, please identify the required source contract; the present UnknownEffectTag does not identify the unresolved spelling.

References in the same official CLI revision: `docs/design/02-general-programming-constructs.md` section 7.2; `docs/design/03-agents-tools-prompts-memory.md` section 2 (the model boundary covers omitted injection); `examples/parameter_injection.es` imports the same standard effect and uses scoped providers.

Exact official graph:
- CLI 9ed6827f16ee081cdaa327780941a3aee8b0c039 (0.24.6)
- Core e0be95b0f5b2ad0f52cb92ca23e88d00cce5ea9f
- Frontend 6ae9e9be24163c2da6d08c1cf53cf097ba13be6a
- Interpreter 4e1f7226e82afdc15ef140baabd7596f31870507
- Standard release binary SHA-256 b49158c9bbf4dbdc835062813b1fe7897fe38594693edeccf9c631226b10fd89
- Matching SDK artifact blake3:b7eafaeb1778b3fd091723803e8ad2cb065e827880bf40447907ad9857db12f3; body 99, metadata 78.

Linux/aarch64, cache off, no compiler/source overrides. This was **check only**: no model, file edit, Memory, command, or runtime action was executed. No new negative matrix or policy bypass is involved.

Source, manifest and complete diagnostics: https://github.com/hrtan99/nomo/tree/refactor/etas-0230-architecture/examples/repros/injected-tools-0246
