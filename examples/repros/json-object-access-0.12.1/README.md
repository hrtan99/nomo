# Native JSON object access dependency

This is an executed capability observation on the official ETAS 0.12.1 graph, not a reported compiler bug.

The dependency-free source parses one JSON object. Its complete closed record projects successfully; projecting that object to `Map<string, JsonValue>` returns `None`. Observed output:

```text
CLOSED_RECORD 7
JSON_OBJECT_MAP_UNAVAILABLE
```

The executable fixture returned zero because it completed the observation. This does not mean native project configuration passed. No model, command process, Memory store or project filesystem operation is involved.

The inspected representations explain this result: maps encode as key/value pair arrays, JSON objects decode to host records, and checked map decoding expects a host map. Closed-record decoding rejects both unknown and missing fields. The registered public `std.json` module exposes `parse` and `stringify`, without object lookup or iteration. These facts do not establish a defect in the documented checked identity cast.

Nomo uses the supported representation boundary: generic codecs produce nested arrays of `{key, value}` entries, and Etas projects those arrays to typed entries. Etas selects its own fields, applies defaults, ignores unrelated keys and validates settings. A public JSON object lookup API could simplify this adapter in future. No hand-written JSON parser, external Nomo configuration controller, compiler patch or weakened record validation is used.

Compiler identity and execution artifacts are recorded in `examples/native-project/json-object-access-20261111.json`. Run this package with the pinned official `etas run ... --allow-effects`; only `console=allow` is required.
