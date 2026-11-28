Reproduced on the unmodified official CLI 0.22.7 as well, including a `while` loop. The matching specification still requires local `@limits` annotations.

```etas
module app.main;

public flow main() -> i32 {
    var index: i32 = 0;
    @limits([Iterations(3)])
    while index < 3 {
        index = index + 1;
    }
    return index;
}
```

In a dependency-free package, `etas --no-config --cache off check .` exits 1:

```text
error[syntax::InvalidExpression]: expected expression
 --> src/app/main.es:5:5
  |     @limits([Iterations(3)])
  |     ^ expected expression
```

The legacy postfix loop bound is also rejected (`expected block` at `limit`). We retain the specified annotation in the migration; we have not removed the loop budget or patched the compiler to make acceptance pass.

Official graph:

- CLI 0.22.7: `aaa5e4bc807c3c1cf7b0c98e90007a3c3f1dda4f`
- Core/std: `61d1686274e7015db9ad7cad4b138cabf73a293a`
- Frontend: `6eff20df98583c9f40b2416a04da34580f4da7aa`
- Interpreter: `fc222d6625591380ca0dde2e8de6a6180e1d7215`
- Official Cargo.lock SHA-256: `93289cb4cb5dbbce1fb14e1d4eca131611461f31fb6140a77cc64a7266b2b3e4`
- Linux/aarch64, standard Cargo dev profile, locked dependencies, default features, no source overrides.
- Built binary SHA-256: `8c497f01faccd88d1ea7760e41d11d5bfabccd201d2593d1fd5a79614149abf3`
- Matching SDK installed through official `etas std install --prefix`; manifest SHA-256: `b76c6aeb1c77271416a6f9ad8a056c8be2e5c37d070c7c26e0d103d45b46dce1`.

The pinned statement parser still has no local annotation entry path. This is a synthetic source-only reproduction with no credentials, model calls, project contents or Host operations.
