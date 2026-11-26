# Source boundaries

The top level follows architectural responsibility. Modules inside each layer follow the business they serve.

```text
src/nomo/
  domain/         Passive records, validation, budgets and state transitions
  application/    Use cases and their consumer-owned spec/effect contracts
  adapters/       storage/, model/, filesystem/, process/, cli/
  bootstrap/      Construct implementations, inject dependencies, install Handlers
    main.es       Native project composition root
```

For example, conversation interfaces live in `application/conversation/ports.es`, requests in `application/conversation/effects.es`, and workflows in `turn.es`, `compact.es` and `startup.es`. `adapters/storage/conversations.es` implements those interfaces. `bootstrap/conversation.es` selects the history, model and context implementations. CLI parsing/rendering lives under `adapters/cli/`.

Application workflows import their contracts and domain rules. They do not import adapters or bootstrap. Domain modules do not import application, adapters or bootstrap. Adapters implement the contracts of their consumers. Bootstrap contains composition, including the legacy mode presets; it contains no concrete `impl` bodies or mutation-policy dispatch. `SessionContext` is a separate conversation contract leaf so mutation contracts and the model capability surface remain acyclic.

Pure wire-format rules remain domain algorithms. Model decoder adapters implement application interfaces by calling those algorithms. Context projection follows the same split: domain selects history and computes the compaction threshold, the application owns `ContextProjection`, and the model adapter measures the serialized context.

## Compatibility identities

Some old module paths remain as **declaration-only compatibility leaves**. They preserve nominal types already used by saved records, Memory schema/resources and filesystem Region configuration. They contain no workflow, model, tool, effect or concrete method bodies. Their executable code has moved into the layers above.

`config/architecture-compatibility.json` records these leaves and fingerprints their preserved declarations. A stored nominal type is not renamed merely to move its file. Conversation/session and execution data have domain-facing re-exports while retaining their original stored identities. A later identity migration needs an explicit versioned storage migration.

Existing untracked v4 prototypes remain local. Their compatibility entries are optional; when present, their declarations are checked. They are not production composition or completed migration acceptance.

## Dependency check

Run:

```sh
python3 -B scripts/check-architecture.py
```

This checks module paths, named public imports, layer direction and cycles, passive domain code, bootstrap implementation placement, and compatibility declaration/Region preservation. `.github/workflows/architecture.yml` runs the same check on pushes and pull requests. It complements the Etas compiler; it does not establish type/effect correctness or runtime acceptance.

The currently selected compiler is official Etas 0.23.0 with its own locked core/frontend/interpreter graph and matching installed SDK. The source refactor remains pending compiler/runtime acceptance; see `NATIVE_MIGRATION.md` for the observed blockers.
