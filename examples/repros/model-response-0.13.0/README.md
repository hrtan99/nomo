# Standard ModelResponse inference — official 0.13.0

Executed dependency-free source reproduction of a raw model-response decode failure. The standard response type is rejected while lowering a typed output schema, before any model Host request. No credentials or live model server are required to observe this failure. The loopback URL is synthetic.

Run `etas run . --allow-effects --trace-out trace.json`. Observed exit status 3 and `InvalidArguments`: `tool schema type std.agent.schema.ModelResponse has no representation and cannot be lowered to host schema`.

The trailing optional JSON projection has not executed; its support is not claimed or required by this report. No local alias, response-shape guess, compiler patch or fallback controller is installed.

Exact graph, observed trace/source hashes and zero model-request evidence: `../../native-project/model-response-0130-20261111.json`. Public issue payload: `UPSTREAM_ISSUE.md`.

Published upstream: https://github.com/etas-project/etas-interpreter/issues/104
