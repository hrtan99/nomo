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

## Construction and execution scopes

`application/conversation/service_ports.es` owns `ConversationService`. The CLI's `TerminalApplication` consumes that spec and receives four construction-time dependencies: history, attempts, picker and conversation. One history object implements its multiple storage roles. The old `ConversationRequests` forwarding effect has been removed.

`adapters/model/conversation_service.es` implements the service with injected storage, context, instruction and model dependencies. `bootstrap/conversation.es` selects these implementations and supplies a configuration loader that shares the same history. Owner-local factories construct records with omitted `@inject` fields inside the provider scope. Generic `T ~ Port` constraints keep startup-selected dependency roles explicit.

Each service call binds its own session/settings effects. The six remaining process, transfer, project, mutation, instruction and command Handlers interpret runtime operations; their original nesting order is preserved. `bootstrap/main.es` separates dependency construction from this execution scope. Providers select stored dependencies and do not replace dynamic effect interpretation.

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

The currently selected compiler is official Etas 0.23.2 with its own locked core/frontend/interpreter graph and matching installed SDK. The source refactor remains pending compiler/runtime acceptance; see `NATIVE_MIGRATION.md` for the observed blockers.

Handler action results use implicit tail resumption. Write `Action(value) => implementation(value);` for one expression and keep a block for statement sequences. Match/lambda expression bodies follow the same minimal form. Keep braces where they preserve a discarded non-unit result, early return, bindings or control flow; keep `finish` when it terminates the handled computation.
