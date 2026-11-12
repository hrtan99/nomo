# Native output capture candidate

`native-output-capture-0133.patch` is based on Nomo commit `a4c54f7` and contains the unaccepted Etas implementation plus its positive acceptance scenario. It registers collectors through a Source effect handled inside the lexical scheduler callback, uses a separate Memory region for immutable output chunks/heads and UI-owned read cursors, seals captured prefixes into export metadata, and settles collectors when the UI closes.

The actual native-entry acceptance failed: after an approved synthetic producer started, the UI waited at its prompt for 20 seconds, zero native `Command.read` requests were dispatched, and the capture head remained at zero events. The run trace recorded `unresolved_resource_selector` serialization. Normal `/quit` completed. A smaller valid package with separate, constant Memory region selectors reproduces delayed child progress; it is reported as [etas-interpreter#108](https://github.com/etas-project/etas-interpreter/issues/108).

The patch also proposes an explicit read-only command policy for automatic output reads; starts, reconnects, input, stops and filesystem writes keep native approvals. This policy and the other capture changes have not passed acceptance and are not installed in the product.

The product source was restored byte-for-byte to the official-0.13.3 workflow accepted in `compiler-0133-20261112.json`. Once the upstream ownership/scheduling contract is available, the candidate can be reviewed with `git apply --check examples/native-project/candidates/native-output-capture-0133.patch`, applied, and its bundled `tests/native_capture_probe.py` run. The complete capture lifecycle, model tool path, bounded byte reads and archive transfer still require acceptance before shipping.
