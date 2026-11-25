# Native migration and output capture candidates

## Combined dependency-inversion proposal, 2026-11-26

`dip-composition-0224-20261126.patch` is the single combined proposal against
`6158d8c`: it incorporates DIP-06 through DIP-12, the startup compatibility
proposal below, and the agent/loop migration. It changes 176 files, including
72 agent declarations, 77 instance references and 256 bounded loops. The adjacent JSON pins every input overlay, changed
source hash and original loop-bound expression. The lower loop count follows
removal of superseded orchestration; it is not a reduction of retained bounds.
`dip-composition-20261126.patch` records the same architecture before the
language migration for review. Both patches start at the same source baseline.

The combined composition resolves the overlapping roots and entry edits:

- One bootstrap installs conversation, mutation, process, transfer and project
  operations. CodingModel, its adapter and the per-turn effect row carry both
  mutation and process operations.
- Entry receives the existing conversation and recovery ports. Its application
  request effect selects turn, compaction and settings use cases at bootstrap;
  it no longer constructs NativeHistory or imports bootstrap implementations.
  Startup selection receives an injected ConversationPicker; per-invocation
  check argv travels explicitly with the settings and turn requests.
- Context obtains instructions from ProjectGuidance and saved jobs from
  JobRepository. Saved metadata acquisition does not invoke process tools.
- Configuration conversion and filesystem mutations use the extracted command
  composition. Cached, its schema and the cache resource remain at the original
  native.configuration owner, alongside the other preserved contract leaves.

Reproduce the preparation with `python3 scripts/prepare_dip_composition.py`.
It applies each input overlay in its own temporary directory, resolves the
recorded overlaps, audits named imports and persistent declarations, preserves
all string literals during syntax migration, and preflights both output patches.
Source snapshots under `tmp/dip-composed-0224-20261126/` include unchanged local
source prototypes; the emitted patches touch only this refactoring's owned
sources, the existing foreground-command fixture and the pending startup
consumer. The source-only counts are 17,017 SLOC selected, 17,234 composed and
17,450 after syntax migration, including those prototypes. Using the full v4
runtime inventory, the corresponding inclusive totals are 21,535 / 21,794 /
22,010 SLOC. Runtime business code has not been retired by the proposal; the
existing user-authorized temporary line-limit exception still applies.

This is **preparation only**: apply preflight and the structural audit do not
prove type/effect correctness or runtime behavior. The known documented loop
syntax blocker [frontend #97](https://github.com/etas-project/etas-frontend/issues/97)
has not been fixed in the prepared official graph, so its failing check was not
repeated. The returned-handler diagnostic
[frontend #99](https://github.com/etas-project/etas-frontend/issues/99), exact Host
adapter witness failure
[frontend #100](https://github.com/etas-project/etas-frontend/issues/100), and
version-scoped old-runtime project consumer failure
[interpreter #118](https://github.com/etas-project/etas-interpreter/issues/118)
retain their own immutable evidence. Historical checks of individual overlays
do not constitute acceptance of this combined source. Full target checking and
the original production consumers, continuous capture/live process gates and
default-entry cutover remain required. No production selector or launcher was
changed by this preparation; DIP-02 through DIP-13 remain unchecked.

## Startup CLI proposal

`native-startup-0224-20261126.patch` prepares typed startup selection, project and
conversation listing, history/status, title/import/export and per-invocation
check overrides. The generic startup use case consumes the existing reader and
catalog roles plus an application-owned ConversationPicker. The all-session
catalog query shares the original Memory paging implementation. Persisted
records, schema and stable IDs are unchanged. The launcher prepares mounts and
forwards argv; explicit inspection/export runs separately from a resident UI.

The normal whole-project check on official **0.13.5** exits 1 (`checked 293
files`): the complete ConsoleConversationPicker implementation is reported as
bodyless/missing choose, followed by missing implementation evidence at its
generic caller. The precise trigger remains unknown. It is a version-scoped
[follow-up to frontend #98](https://github.com/etas-project/etas-frontend/issues/98#issuecomment-7173748938),
not a claim of a latest-graph regression. All six changed production files were
restored byte for byte; the three new Etas files and future positive consumer
remain only in the patch and exact rejected snapshot. The source check blocked
execution of `tests/native_startup_probe.py`; none of its proposed startup,
resident-inspection, export or check-override runtime assertions are accepted.
The adjacent manifest pins the checked Etas hashes separately from subsequent
unexecuted corrections to shell forwarding, fixture data and recent-project
bookkeeping order.

The combined proposal injects the chooser at bootstrap and binds check argv as
ordinary request data. It contains no alternate production handler or compiler
workaround. It still does not establish full shipping CLI parity: native
`--latest` uses the selected native binding, cross-project resume requires the
correct mount, archive paths retain ProjectRoot rules, and legacy selectors/IDs
still need their explicit migration route. The shipping launcher has not changed.

## Language migration for official 0.22.4

`language-migration-0224-20261125.patch` reflects the currently selected source plus required SDK API changes: 72 tracked agent declarations, 77 instance references and 268 bounded loops in 108 files. It converts each agent to an empty active type with an explicit public `run(self, ...)` method, retains callable constraints on that method and constructs scoped instances at ordinary call sites. The loop migration uses the specification's prefix `@limits([Iterations(...)])` syntax. Removed command construction/process helper functions migrate to the matching SDK's `Command` and `CommandHandle` methods. Prompts, tool lists and bound expressions are retained. This syntax-only patch changes 122 product files; untracked session prototypes are excluded. The adjacent JSON manifest records source/candidate hashes, exact bound expressions and successful apply preflight. It is prepared, not accepted by the target compiler.

`language-migration-0224-20261125-baseline-a3450bc.patch` preserves the exact original executed candidate. Its normal source check failed with `checked effect tag has conflicting package identities`; that cause remains unestablished. A separate one-loop package proves that the documented prefix annotation is rejected by the official 0.22.4 graph: [etas-frontend#97](https://github.com/etas-project/etas-frontend/issues/97). The official compiler build, matching SDK installation and constructor-injection example passed independently. `../toolchain-0224-build-20261125.json` still points to the exact original candidate and diagnostic; `../../repros/scoped-loop-limits-0.22.4/` contains the executed minimal reproduction.

The domain-view and conversation-port preparations are accepted on the existing 0.13.5 path. `../domain-views-20261125.json` records the first slice; `../conversation-ports-20261125.json` records the pure history contract leaf, application-owned reader/writer/catalog, Memory adapter and injected context reader. The latter passed the normal 252-file check, existing configuration/summary/fresh-process scenario and restoration from a database saved by the preceding source revision. Default selection remains 0.13.5. Reapply the current candidate once the scoped-loop contract is available, then complete the required normal target-graph check and native/shipping-entry workflows. No target-graph acceptance is claimed for these later slices.

`../execution-ports-20261125.json` records the subsequent generation/result contracts, pure attempt rules, injected execution service, Memory attempt repository and bootstrap selection. Its normal check covered 257 files. Normal conversation, native foreground interruption, completed/incomplete result restoration and exact restoration of nine old-source attempt records passed on 0.13.5. The earlier candidate snapshot is identified by the Git revision recorded in `conversation-ports-20261125.json`; the current candidate remains unaccepted on the target compiler.

## Foreground command application/Host separation proposal

`foreground-command-dip08-0224.patch` retains the complete unintegrated command extraction: domain argv/stdin records and operation classification, shared application sequencing, separate Host and preview adapters, bootstrap bindings and the necessary consumers/fixture. The project-root marker retains its original module identity. The retained 0.13.5 compiler rejected the new adapter implementations as bodyless/missing method evidence, including in an isolated dependency package with explicit effect contracts. No compiler or module-order workaround was introduced; all product and test files were restored to `14f0635`.

The matching 0.22.4 SDK removes the old free `command`, `with_cwd` and `with_stdin` functions. After using the official `Command.new(...).with_cwd(...)` and `with_stdin(...)` methods and declaring the implementation effect rows, the exact eight-file package in `foreground-command-0224-check/` passed its normal check. It was not executed. `foreground-command-dip08-0224.json` records the selected SDK identity, source hashes and scope of that proof. The complete command/Git/stdin and fake-runner acceptance remain pending target integration; no full-product or runtime pass is claimed. The canonical migration candidate now also records the matching `CommandHandle` method API required by the saved-process code.

## Historical continuous capture proposal

`native-output-capture-0133.patch` is based on Nomo commit `a4c54f7` and contains the unaccepted Etas implementation plus its positive acceptance scenario. It registers collectors through a Source effect handled inside the lexical scheduler callback, uses a separate Memory region for immutable output chunks/heads and UI-owned read cursors, seals captured prefixes into export metadata, and settles collectors when the UI closes.

The actual native-entry acceptance failed: after an approved synthetic producer started, the UI waited at its prompt for 20 seconds, zero native `Command.read` requests were dispatched, and the capture head remained at zero events. The run trace recorded `unresolved_resource_selector` serialization. Normal `/quit` completed. A smaller valid package with separate, constant Memory region selectors reproduces delayed child progress; it is reported as [etas-interpreter#108](https://github.com/etas-project/etas-interpreter/issues/108).

The patch also proposes an explicit read-only command policy for automatic output reads; starts, reconnects, input, stops and filesystem writes keep native approvals. This policy and the other capture changes have not passed acceptance and are not installed in the product.

The product source was restored byte-for-byte to the official-0.13.3 workflow accepted in `compiler-0133-20261112.json`. Once the upstream ownership/scheduling contract is available, the candidate can be reviewed with `git apply --check examples/native-project/candidates/native-output-capture-0133.patch`, applied, and its bundled `tests/native_capture_probe.py` run. The complete capture lifecycle, model tool path, bounded byte reads and archive transfer still require acceptance before shipping.

## Official 0.13.4 consumer result

The original #108 package passes unchanged on 0.13.4. The same capture patch was then applied without product changes, and its actual-entry scenario still failed: zero output events and zero `Command.read` requests during the 20-second input wait, followed by a normal `/quit`. The product source was restored to the 0.13.4 workflow accepted in `compiler-0134-20261112.json`; its recorded source hashes match exactly.

The smaller remaining case uses computed keys in the child's independent region. It is reported as a [consumer follow-up to #108](https://github.com/etas-project/etas-interpreter/issues/108#issuecomment-6815750299), with explicit acknowledgement that the conservative fallback may be intentional. `task-memory-log-0134-20261112.json` records both the computed-key case and the unchanged candidate result. The patch remains unaccepted; the remaining dependency is a supported dynamic resource ownership contract.

## Official 0.13.5 consumer result

The unchanged computed-key reproduction now passes with both child writes during the owner's input wait and no serialization. The complete candidate was applied unchanged to `fddb4ed` and still fails: zero saved events/bytes out of 2,555,904 intended bytes, zero native reads and two `unresolved_resource_selector` events on scope 0 during the 20-second wait. Normal quit completes. The scenario stops before its fresh-Host/partial-read checks, so neither is accepted. `../capture-consumer-0135-20261112.json` records the exact trace and candidate identities; `UPSTREAM_0135_FOLLOWUP.md` records the consumer follow-up.

The product is restored byte-for-byte to the 0.13.5 source accepted by `../compiler-0135-20261112.json`. This patch remains an unaccepted proposal. The remaining full-consumer ownership/opaque-resource behavior must be resolved without bypassing guards; the reduced dynamic-key fix is accepted.
