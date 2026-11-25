# Official 0.22.4 process adapter static-check failure

This is the exact six-source snapshot that exits 4 with the matching installed SDK:

```sh
etas --no-config --cache off check --all .
```

Observed stderr: `frontend session failed: Pipeline("native invocation has no checked implementation witness")`.

Only source checking was performed. The adapter uses the matching Command and CommandHandle methods and a spec parameter for the transient handle type. The Region declaration retains the production ProjectRoot identity. The generic consumer asks the checker to resolve the concrete adapter; it was not executed.

This does not establish native process execution, approval, live reconnection, output capture or production composition acceptance. The exact triggering invocation is unknown. The upstream diagnostic report is https://github.com/etas-project/etas-frontend/issues/100 . The complete unaccepted composition is retained in `../processes-dip10-0224.patch`.
