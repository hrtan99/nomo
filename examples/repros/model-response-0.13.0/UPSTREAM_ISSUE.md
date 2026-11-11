## Observed on the official 0.13.0 graph

- CLI `6ceb644a17b159a5ee9a988cbbba0700aebf5e46`
- core `cdb49367e73aadba56fbc89c984668ee3c1dd0aa`
- frontend `b09ceec7f57d1791dc92d358150cfc8c87935771`
- interpreter `7422fb134d2606cc28b7af9c69e98668ba5411c0`
- Ubuntu 26.04, Linux/aarch64, unprivileged Docker user; no source overrides.

The standard `std.agent.schema.ModelResponse` return type is rejected as a nominal type without a host-schema representation before any model request. This prevents using the existing raw-response decode path from a source agent.

## Executed standalone source

`etas.toml`:
```toml
[package]
name = "response-api"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow", "model=allow", "tool=allow"]
[runtime.profiles.local.model]
adapter = "openai"
model = "synthetic"
base_url = "http://127.0.0.1:18099/v1"
allow_private = true
typed_output_encoding = "output-tool"
[[bin]]
name = "response-api"
module = "app.main"
flow = "main"
```

`src/app/main.es`:
```etas
module app.main;
import std.agent.message.Message;
import std.agent.schema.ModelResponse;
import std.json.{JsonValue, stringify};
import std.io.println;

public tool ping(value: i32) -> i32 ![] { return value + 1; }
@tools([ping])
@limits([Tokens(4096), ContextTokens(1048576)])
agent Worker(input: string) -> ModelResponse {
    return perform infer<ModelResponse>(Prompt.new().system(Trusted(input)));
}
flow main(args: Array<string>) -> i32 ![Agentic, Console, Error<IOError>] {
    let response = Worker.run("Call ping with value 7.");
    let converted: Option<Message<JsonValue>> = Message.new(response).cast<JsonValue>();
    match converted {
        Some(value) => { println(match stringify(value.body) { Ok(text) => text, Err(_) => "ENCODING_UNAVAILABLE" }); }
        None() => { println("RAW_RESPONSE_NOT_JSON_PROJECTABLE"); }
    }
    return 0;
}
```

Run `etas pkg lock .`, then `etas run . --allow-effects --trace-out trace.json`.

## Actual

Exit status 3:
```text
error[analysis::InvalidArguments]: tool schema type `std.agent.schema.ModelResponse` has no representation and cannot be lowered to host schema
  | return perform infer<ModelResponse>(Prompt.new().system(Trusted(input)));
  |        ^ tool schema type `std.agent.schema.ModelResponse` has no representation and cannot be lowered to host schema
```

The captured trace is failed and contains **zero model Host boundaries**. The consumer applied no compiler/Host patch. The optional trailing JSON projection is not reached; this report makes no claim about whether that separate conversion is supported.

## Expected and suspected cause

The builtin raw response type should select `ModelDecode::ModelResponse`, so it does not require a typed-output host schema. With a suitable local model stub it should return the raw response; the stub is unnecessary to observe the current pre-request failure.

In the pinned interpreter's [agent decode classifier](https://github.com/etas-project/etas-interpreter/blob/7422fb134d2606cc28b7af9c69e98668ba5411c0/crates/etas_interpreter/src/eval/agent.rs), `type_is_model_response` only accepts `Type::Named` with the exact unqualified name. The actual failure comes from the `Type::Nominal` no-representation branch of `host_schema_for_type`. The standard [schema declaration](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_std/src/modules/agent/schema.rs) already carries `RuntimeTypeRole::ModelResponse`. This suggests the classifier no longer recognizes the current standard type representation. This cause is an inference from source; the failed run/zero requests above are directly observed.

Please recognize the actual builtin role/type identity rather than requiring consumers to introduce a fake type alias or enable a broad raw-decode override for unrelated outputs. An acceptance test should exercise the source `infer<ModelResponse>` path, including `@tools`, rather than only constructing Rust-side `ModelDecode::ModelResponse` values.

Issue search for `ModelResponse` in this repository returned no matches before filing. Payload contains only official versions, synthetic source/configuration and error details; no real project content or credentials.
