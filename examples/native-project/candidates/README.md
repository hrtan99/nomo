# Native output capture candidate

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
