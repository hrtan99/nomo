## Standard Clock.now is rejected before execution on official 0.24.3

This legal synthetic program passes normal O2/cache-off checking with zero diagnostics:

```etas
module app.main;
import std.runtime.time.{now, TimeError};
import std.io.{println, IOError};
import std.text.from_i128;
public flow main(args: Array<string>) -> i32 ![Console, Error<IOError>, Error<TimeError>] {
    println(from_i128(now().unix_millis));
    return 0;
}
```

Runtime configuration (the package has this flow as its bin):

```toml
[runtime]
default_profile = "local"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow", "clock:Clock.now=allow"]
```

Run `etas --no-config --cache off run . --allow-effects`.

Actual exit 3, stdout empty:

```text
error[analysis::MissingHostHandler]: missing Phase 1 host service for Time
 --> /workspace/src/app/main.es:5:8
```

Expected: the official CLI supplies/advertises its standard Clock service and evaluates one allowed Clock.now request, or exposes a documented configuration switch for that service. This blocks native conversation timestamps and last-updated ordering. No Nomo import, Memory, command, filesystem, model, credentials or private data is involved.

Read-only source findings on this exact graph:
- CLI `crates/etas_cli/src/command/interpreter/host.rs:129-148` constructs HostServiceAvailability and falls back to default without setting `time`.
- Interpreter HostServiceAvailability defaults `time` to false; its entry-readiness check emits this diagnostic for HostRequirementKind::Time.
- Interpreter `HostServices::clock` already has a default dispatch to `etas_host::clock::clock`; core implements ClockOperation::Now using SystemTime. The CLI availability omission is therefore a likely cause, not a patched or executed fix.

Exact unmodified release graph:
- CLI dd5768dc871b99fb4cc06c4532c772e257d2f64b (0.24.3)
- Core 377875e8afb201a782e054b313fe7e529bcaa485
- Frontend bfe255314bc142fdd79a7c5d3d7f0cc77988574e
- Interpreter 5dfc2a121efb326107d461e08e66b31499db143b
- Binary SHA-256 a172dd7a35541f91ebaa0fb4462f462fe76374bc8d3ffa6f2237a87e76d7d8f2
- Matching SDK compiler 0.21.3, body 98, metadata 78; std artifact blake3:d8d154d5d1d2820c9b26bb62c6a5ebb74d138accaa930a363f15f7de5be135e2.

Linux/aarch64, no compiler patch, source override, custom Rust flags or readiness override. No process-command/Python clock bridge, fake production clock or default timestamp is introduced. Exact synthetic package and result are retained under `examples/repros/clock-now-0243` in hrtan99/nomo's review branch.
