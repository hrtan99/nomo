# Message to JSON Map layout, official Etas 0.24.2

This independent synthetic record reproduces the context serializer's `slots` layout failure. It has no Nomo imports, Memory operation or model call. See [UPSTREAM_ISSUE.md](UPSTREAM_ISSUE.md) for the exact graph, command and trace observation, and [result.json](result.json) for the captured result.

The standalone CLI exits 3 without printing its diagnostic; the trace contains `Analysis(MissingCheckedFact)`. This is a failed run, not an application acceptance result.

Upstream: [etas-interpreter #119](https://github.com/etas-project/etas-interpreter/issues/119).

The unchanged source passes on official 0.24.3 with its matching SDK. The original `result.json` above remains the failed 0.24.2 observation. See the [0.24.3 receipt](../../native-project/compiler-0243-20261127.json) and [upstream follow-up](https://github.com/etas-project/etas-interpreter/issues/119#issuecomment-7207022235).
