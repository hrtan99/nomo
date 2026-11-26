Official CLI 0.24.2, with its exact locked graph and matching installed SDK, fails a standard `Message.new(record).cast<JsonValue>()` followed by `std.json.stringify`. This reproduction uses one synthetic record, no Nomo imports, no persistence, no model, and no Host requests.

```etas
module app.main;

import std.io.{println, IOError};
import std.agent.message.Message;
import std.json.{JsonValue, stringify};

type Item = { text: string, count: i64 };

public flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    let converted: Option<Message<JsonValue>> = Message.new(Item { text = "synthetic", count = 7 }).cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => abort("record conversion failed") };
    let text = match stringify(value) { Ok(text) => text, Err(_) => abort("JSON encoding failed") };
    println(text);
    return 0;
}
```

Run in a package with console permission:

```sh
etas --no-config --cache off run . --allow-effects --trace-out trace.json
```

Observed exit: 3. Both stdout and stderr are empty in the standalone reproduction. The trace reports:

```text
Analysis(MissingCheckedFact)
field `slots` expects 4 record fields, received ["entries", "length"]
```

`outcome.kind=failed`, `failure.kind=execution_fault`, `termination.local_work_settled=true`, operations empty, zero Host requests. Expected: serialize the record to a JSON object and print it. The same diagnostic appears in the application context serializer, where the CLI does print it but associates it with an unrelated application type's span.

Likely boundary (source inspection; not a claim of a complete fix): `eval/host_value.rs` at interpreter 420c6ca, around lines 337–352, transforms `HostValue::Map` into a source Map record containing only `entries` and `length`. The selected core standard library's Map uses a slots-based representation. Please align the checked source representation conversion rather than weaken the layout validation.

Exact official graph:
- CLI: e692939c4c22fab5260cfc8ffbcac4ea9e139f93 (0.24.2)
- Core: 44a25f003d996dd89230295f111e617c0a2a3783
- Frontend: c0c87cf3acdcfd2cfdd77d13e6bd3a905bc55fd7
- Interpreter: 420c6ca133de802d1deb4fffaf755f35b988318f
- CLI binary SHA-256: 1ff558745bee375c84bbcdda22a4ef894b22d8348edf0eb2d0dabc7612f41d78
- SDK compiler 0.21.2, body schema 97, metadata schema 78; matching SDK receipt verification passed.
- Standard Cargo release build, Linux/aarch64, no compiler source patches, Rust flags or source overrides. Cache off in the reproduction.
- Runtime memory limit 4 GiB, peak 374,546,432 bytes; no max/OOM/OOM-kill event. Elapsed about 1.4 s.

The local reproduction manifest enables only console and selects app.main.main. Full source and trace summary are retained in the Nomo review branch under examples/repros/message-json-map-0242. Payload is synthetic code, public revisions and diagnostic metadata only.
