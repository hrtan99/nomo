## Version-scoped runtime diagnostic (official 0.13.5)

The normal whole-project check succeeds (`checked 295 files`, exit 0), but the actual project-entry consumer fails before its first terminal prompt:

```text
error[analysis::InvalidArguments]: path does not name a runtime value in the current frame
 --> /workspace/src/nomo/bootstrap/projects.es:25:69
  | ProjectOperations.remember(workspace) => { service.remember(recent, workspace); resume; }
  |                                                           ^
```

The indicated argument is an immutable dependency declared by the factory returning this Handler. The relevant shape is:

```etas
let recent = NativeRecentProjects {};
return handler {
    ProjectOperations.remember(workspace) => {
        service.remember(recent, workspace);
        resume;
    }
};
```

The factory explicitly acknowledges Memory requests and declares its Handler's produced row. The concrete recent-project repository, launch-control and terminal renderer implementations all check in this consumer. This excerpt describes the observed shape; it is not a standalone reproduction or a claim that the precise trigger has been isolated.

## Observed runtime evidence

- The full retained-Host project-switching consumer was attempted, not replaced by a reduced success case. It fails at startup before it can exercise switching.
- The runtime trace ends with `outcome.kind = failed`, `failure.kind = execution_fault`, and diagnostic `Analysis(InvalidArguments)` with the message above.
- `termination.local_work_settled = true`, with no unfinished operations.
- There are zero Host requests: no Memory/Console action, filesystem operation, native command or model request executed before this error.
- The owned worker exited and was automatically removed. The unaccepted integration was restored; the previously accepted production path remains selected.

Expected: resolve the legal dependency used by the Handler arm, or provide a source-contract/unsupported-feature diagnostic before accepting the program. Please confirm whether this older frame-resolution diagnostic is a known resolved defect and identify the relevant fix or required source contract.

## Scope and graph

This reports **0.13.5 only**. The full consumer has not been accepted on 0.22.4: current adoption is independently blocked by frontend #97 and other reported target diagnostics. No claim is made that this runtime failure exists on the latest graph, and no backport is assumed. No compiler/interpreter patch, module/file-order change or alternative production handler was installed.

- CLI: `826bf13bea02f1c1468e6b97b8d2ec7dad2ebc0e` (0.13.5)
- Frontend: `bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1`
- Core: `faa01c5752bfe3e46a187ee6e3def3911ab2430b`
- Interpreter: `3c0b78fbf147e5bb2fc33e13a501a88b97411d1c`
- Official unmodified locked graph; Linux/aarch64.
- CLI binary SHA-256: `9be1cb60d532d954538b72206507e27439a427402c67cf384249831bc304c2f2`
- Payload scope: diagnostic text, a short synthetic dependency/Handler excerpt, public revisions and trace summary; no complete application source, project files or credentials.
