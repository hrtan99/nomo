Reported upstream: https://github.com/etas-project/etas-interpreter/issues/123

## Observed integration failure

On the unmodified official CLI 0.24.6 locked graph, the existing full Nomo native batch/undo consumer passes normal source checking, successfully applies a batch in its first model turn, then fails in its second model turn:

```text
error[analysis::UnhandledEffectAction]: unhandled effect action ChangeOperations.undo escaped the checked-HIR interpreter entry
 --> /workspace/src/nomo/adapters/model/tools/mutations.es:50:12
  |     return perform ChangeOperations.undo(perform SessionContext.current(), edit);
```

The exact program and original four-response localhost synthetic model are in the public Nomo review branch. The existing driver is `python3 -B tests/native_mutations_probe.py`. No real provider request, private project, compiler override or extra adverse case is involved. This report is the existing positive integration case, not a newly executed standalone minimal reproducer.

The root installs all seven ChangeOperations arms through `nomo.application.mutations.handlers.operations`, outside the terminal application's whole run. Its apply arm resolves successfully during the first inference. The undo arm is present in the same returned Handler. The model adapter creates a fresh NativeCoding instance for each call and binds its per-call SessionContext/SettingsContext. Agent/tool call context should retain caller handlers under the published [agent/tool contract](https://github.com/etas-project/etas/blob/9ed6827f16ee081cdaa327780941a3aee8b0c039/docs/design/03-agents-tools-prompts-memory.md); [effect resumption](https://github.com/etas-project/etas/blob/9ed6827f16ee081cdaa327780941a3aee8b0c039/docs/design/06-effect-system-and-inference.md) is deep.

Actual source excerpt, declarations and unrelated arms omitted (not a complete standalone program):

```etas
public tool undo_changes(edit: string) -> ChangeOutcome
    ![SessionContext.current, ChangeOperations] {
    return perform ChangeOperations.undo(perform SessionContext.current(), edit);
}

// Returned Handler installed by bootstrap around application.run:
ChangeOperations.apply(session, name, changes) => execute(files, journals, history, output, session, "apply", name, changes, "");
ChangeOperations.undo(session, edit) => execute(files, journals, history, output, session, "undo", "", [], edit);
```

The sibling apply_changes tool delegates through the shared apply_plan flow; undo_changes directly performs its action. This is an observation, not an isolated root-cause claim. The current source also adds a pure MutationFiles.backup action, answered by its local file-access binding, to move the snapshot location out of application policy. We have not established whether that source change, a previously untested integration path, or the runtime version triggers the failure. No wrapper was introduced to bypass the failing model-tool path.

## Retained state and continuation

The failed trace completes/settles all 1,207 started Host requests, including three localhost synthetic model requests, fifteen commands and two filesystem replacements. Independent native approval auditing passes for the protected operations that did execute. Before recovery the journal is still applied; the first coding attempt is completed and the second is dispatching without a result. No undo dispatch is observed.

We then continued that same retained journal through one explicit terminal `/undo native-0-1` in a fresh process, without repeating forward changes or any model request. It succeeds with fifteen fresh native approvals, restores text, binary bytes, directories and mode 0751, and finishes/settles 719 Host requests. The original model-driven test remains failed; the terminal continuation does not qualify it or mark the interrupted inference successful. The controlled application/native-journal consumer also passes its existing apply/undo/explicit rollback assertions, including the injected alternative backup location.

Related older closed reports may be relevant, but a common cause is unproven: [#53](https://github.com/etas-project/etas-interpreter/issues/53), [#71](https://github.com/etas-project/etas-interpreter/issues/71).

## Exact toolchain

- CLI: 9ed6827f16ee081cdaa327780941a3aee8b0c039
- Core/std: e0be95b0f5b2ad0f52cb92ca23e88d00cce5ea9f
- Frontend: 6ae9e9be24163c2da6d08c1cf53cf097ba13be6a
- Interpreter: 4e1f7226e82afdc15ef140baabd7596f31870507
- Official Cargo.lock SHA-256: 1922fa1369c94d2b81c59f1a81800b90ecc63d61de0a677b697f4f61f3d56437
- Standard release binary SHA-256: b49158c9bbf4dbdc835062813b1fe7897fe38594693edeccf9c631226b10fd89
- Freshly installed matching SDK artifact: blake3:b7eafaeb1778b3fd091723803e8ad2cb065e827880bf40447907ad9857db12f3
- aarch64-unknown-linux-gnu; normal 4 GiB / 4 CPU / 256 PID application profile

Full source check: 467 modules, zero diagnostics, 66.17s, no OOM. The existing normal business case was not weakened or automatically retried. Please investigate the model tool's enclosing-handler context across inference/tool completion. The observed failure does not establish a regression against a previously accepted identical source snapshot.
