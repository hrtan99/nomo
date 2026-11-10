## Summary

On official ETAS CLI 0.12.0, a valid `std.text.get_char_slice` call hangs with one CPU saturated when copying the selected text requires more than one native work quantum. No model, network, filesystem or Memory Host is needed.

## Compiler identity

- CLI `fe3de961aa2f1c55ec2ab5fc31383ea1d3e16af9` (0.12.0)
- Interpreter from its official Cargo.lock: `4f5eae3702605f8630c682d54689167c2dea8394`
- Core `3fc5b68bc886c952559003375590ccd0f95a53cb`
- Frontend `c70b4802768393ed7310a33c4e38a8b8fb2e9692`
- CLI binary SHA-256: `028e82c1b1ed7eef6dbea86c4d56bdd222a700d867e198c761a776b1ef1f883f`
- Linux arm64 container on macOS arm64; no compiler or standard-library patches.

## Reproduction

Dependency-free package with edition `2026`, source root `src` and bin module `app.main`, flow `main`. The local static runtime policy permits `console=allow`.

```etas
module app.main;

import std.io.println;
import std.text.{get_char_slice, len, from_usize};

flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    var text = "x";
    var index = 0;
    while index < 17 limit Iterations(17) {
        text = text + text;
        index = index + 1;
    }
    println("SLICE_START");
    let selected = get_char_slice(text, Range.closed(0, 70000));
    match selected {
        Some(value) => { println("SLICE_BYTES " + from_usize(len(value))); }
        None() => { abort("valid slice returned None"); }
    }
    return 0;
}
```

Run:

```sh
timeout --signal=INT --kill-after=2s 30s etas run . --allow-effects
```

Expected: `SLICE_START`, then `SLICE_BYTES 70001`, successful exit.

Observed on 2026-11-11: `SLICE_START` is printed, no slice result is produced, and the external timeout returns 124. Shutdown also reports `command output did not settle before forced shutdown`.

The issue was first observed while archiving a synthetic 2,400,000-byte conversation message in 65,536-scalar chunks. The application made progress through 36 chunks, then stopped advancing for several minutes at about 100% of one CPU. It was interrupted; there were zero model HTTP requests. The small reproduction above removes that application's storage and chunk loop.

## Suspected continuation error

At the pinned interpreter revision, `crates/etas_interpreter/src/intrinsic/pure/work.rs`, `TextWorkState::Scalar` first does `skip_until(projection, start, ...)`, then returns `Pending` unless `projection.position() == start`, then runs `append_until(projection, end, ...)`. `append_until` can yield after copying part of the slice. On the next poll, the projection cursor is already greater than `start`, so the equality check returns `Pending` forever. The work quantum is 64 KiB. This source explanation is an inference; the hang above is the directly observed behavior.

Please preserve the supported string API and repair native continuation. The application has not replaced slicing with a local workaround or patched the runtime.
