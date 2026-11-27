# Source boundaries

The default `scripts/nomo` launcher runs the Etas composition root. `nomo-native` is an alias. Python is limited to the Docker terminal transport, historical inspection, one-time source extraction and engineering tools; the former Python project controller and its Action bridge are removed.

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

`application/conversation/service_ports.es` owns `ConversationService`. The CLI's `TerminalApplication` consumes that spec and receives four construction-time dependencies: history, attempts, picker and conversation. One history object implements its multiple storage roles. The old `ConversationRequests` forwarding effect has been removed. `NativeJobs` directly implements the context consumer’s `SavedJobsReader` port; no intermediate record is needed to forward the read to its existing session job listing.

`ProjectInstructionFiles` likewise implements both the low-level instruction file source and the context reader. Plain record construction stays at its call site; a bootstrap factory is retained when it resolves injection or installs an execution scope. The [redundancy scan](examples/native-project/redundancy-20261126.json) records removed wrappers and retained state/protocol adapters.

`application/conversation/service.es` owns the generic `Conversation` orchestration. Its storage, attempts, instructions, saved jobs, models, projection, configuration reader and output sink are construction-time dependencies. `bootstrap/conversation.es` selects the concrete implementations. Configuration is a consumer-owned `ConversationConfiguration` port, rather than a callback tied to a model adapter; terminal output uses `ConversationOutputSink`.

`application/configuration/service.es` owns `ConfigurationLoader`, consuming source, codec, converter and cache specs directly. The former eight configuration forwarding actions are removed. Session is an explicit converter argument; the Taplo adapter alone binds its command helper's ambient session. Model session/settings remain private to the native coding adapter and local to each call.

Generic command, process, project, transfer, mutation and workspace Handlers live in their `application/*/handlers.es` modules. They consume ports and import no concrete adapters. Bootstrap selects every external implementation and shares one history, attempts repository, jobs repository, guidance reader and console output across the consumers. Handler nesting still places command/workspace interpretation outside operations that request them. Configuration and dependency construction do not replace runtime effect interpretation.

`application/workspace/service.es` owns file/instruction/metadata/search observations, consuming `ConversationWriter`, `ProjectFileSource` and the existing `InstructionReader`. It saves the request before IO and the returned result afterwards, without claiming a mutating pending slot. Session is explicit at the `WorkspaceObservations` boundary. `ProjectFiles` supplies actual rooted reads/list/stat; model tools adapt their arguments to the application requests, and CLI file reads use the same requests directly. Recursive discovery constructs the existing command arguments in `application/workspace/discovery.es`. File adapters no longer import conversation storage or model tools. The redundant `ProjectInstructions` forwarding effect and Handler are removed.

`NativeHistory` directly implements the copy repository and mutation-specific history roles. Mutation reads reuse `ConversationReader` instead of redeclaring its methods. `ConsoleLines` directly implements conversation output, mutation output and process preview roles. The redundant storage/output records and the test-only production execution shims are removed. CLI project/copy/process/recovery dispatch requests application effects directly instead of going through model-tool forwarding modules.

`ProcessControl<Live>.start` returns the implementation's actual transient capability. Its pure `reference` operation supplies the string saved in job metadata. The Host adapter selects `CommandHandle`; controlled consumers can select their own token type. The application no longer requires the adapter to discard the live capability before returning. Domain job/stream names re-export the preserved stored nominal contracts, matching the conversation compatibility pattern; four identical-field conversions are removed. Stored declarations and native approvals are unchanged. The retained continuous-capture proposal is unselected: its ordinary check fails on generic effect admission and Task/spec callback facts, reported in frontend #103.

Model-enabled runtime profiles explicitly allow the agentic boundary as well as model requests; tool, filesystem and command approval rules remain separate. Bounded operations declare `Error<BudgetExceeded>` through their consumer specs and callers; storage implementations explicitly declare their durable write effects. Current positive-path validation and the independent standard JSON execution blocker are scoped in [the IoC receipt](examples/native-project/ioc-20261127.json).

## Legacy edit boundary

The Work controller consumes separate `WorkEditor` and `WorkConfirmation` roles. File adapters implement rooted reads/replacement; terminal adapters own presentation and current consent. `application/edit/confirmation.es` constructs the validated preview, and `domain/mutations/edit_diff.es` renders its pure diff. `application/edit/execute.es` owns confirmation, durable intent, file application and journal completion through the existing journal and output roles. The legacy CLI coordinator selects implementations and invokes that use case.

The two confirmation gates and the original persistence/write order remain in place. Exact final compilation scope and the runtime qualification are in [the edit receipt](examples/native-project/edit-confirmation-ioc-20261127.json).

Legacy edit-journal transitions now live in `application/sessions/edit_operations.es`, consuming the existing `CasRows` role. History-work format/budget checks live in the domain, while its application service consumes `CasRows` and `PriorChatReader`. Native adapters provide Memory rows and chat reads. Five concrete WorkPersistence implementations belong to `adapters/storage/work_persistence.es`; the four CLI roots construct them without defining storage implementations. The exact source/runtime qualification is in [the legacy persistence receipt](examples/native-project/legacy-persistence-ioc-20261127.json).


Followup admission/claim/completion and predecessor sequencing also belong to application/sessions/history_followup. Its FollowupPredecessors port exposes the first work, edit and check observations; NativeHistoryFollowup supplies those readers plus the existing CAS/chat roles. Recoverable work record constructors and pure binding/event rules live in domain/sessions/recoverable_work_state. ProjectLaunchControl exposes only publication of the selected directory; its filesystem adapter owns the control-file path. Final checked scope and remaining runtime work are recorded in [the followup receipt](examples/native-project/followup-policy-ioc-20261127.json).


Terminal orchestration lives in application/conversation/terminal. Domain Options/Command/GitRequest describe requests; TerminalInput supplies parsed commands, and TerminalOutput emits typed outcomes to TerminalDisplay. CLI owns input parsing, JSON encoding, tags and help text. Git and configured-check policy are application use cases shared by the terminal and model tool entry adapters. Bootstrap selects the concrete terminal implementations. Exact source and ongoing original runtime scope: [terminal IoC receipt](examples/native-project/terminal-ioc-20261127.json).

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

The currently selected compiler is official Etas 0.24.13, built with the standard Cargo release profile and its exact locked core/frontend/interpreter graph, with a matching installed SDK. See `NATIVE_MIGRATION.md` for the current compiler and runtime acceptance scope.

Handler action results use implicit tail resumption. Write `Action(value) => implementation(value);` for one expression and keep a block for statement sequences. Match/lambda expression bodies follow the same minimal form. Keep braces where they preserve a discarded non-unit result, early return, bindings or control flow; keep `finish` when it terminates the handled computation.
