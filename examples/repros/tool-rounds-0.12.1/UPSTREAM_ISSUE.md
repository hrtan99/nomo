## Observed behavior

On official ETAS CLI 0.12.1, a normal multi-step native `@tools` task stops with:

```text
error[analysis::UnhandledRuntimeError]: model tool-call loop exceeded the maximum number of rounds
```

The integration made nine local synthetic HTTP model requests. File read, native approval and edit, a successful command check, Git status/diff/init/branch/switch completed. The next planned native commit was not executed, and the requested task could not reach its final answer. This is a partial execution, not a rollback. The synthetic replies all included valid usage and valid registered tool arguments; each reported 100 input and 20 output tokens. The agent's limits were 131072 generation tokens and 1048576 context tokens. No real model provider or credentials were involved.

## Official identity

- CLI 0.12.1 `a3c49ffb19d2b3770c9232eb975f605fcf6ac876`
- core `0f599a84dd00c3abe71f6549004776672f62f02f`
- frontend `88764266e384ae8035f44892c9093aabc1761d0f`
- interpreter `cb8c48c0d09c78ce24201ceb13d2ec72a14a2555`
- Official CLI Cargo.lock SHA-256 `17c6917c08188ad98daaea2a230a6ff31a58756568fb6c627bf2dd8248af628f`
- Built Linux/aarch64 binary SHA-256 `fb3e472c80a3b3e33829e47f22188ea6513cc708a040f9845774eb6d42f7211e`
- No source or Cargo dependency overrides.

## Configuration gap

At the pinned interpreter revision, `ModelExecutionPolicy::phase1_default()` in `crates/etas_interpreter/src/api/options.rs` sets `max_tool_rounds: 8`. Agent inference copies this value into pending inference. `eval/machine/model.rs` aborts at the round limit. At the pinned CLI revision, `crates/etas_cli/src/command/interpreter/host_config.rs` constructs the policy with `..ModelExecutionPolicy::phase1_default()`; inspection found no CLI, environment or runtime profile field exposing this policy value. Raising `Tokens`/`ContextTokens` does not change it.

Is there an existing supported setting? Otherwise please expose a documented runtime profile / CLI option for tool rounds and carry it into native inference, with an adequately large selectable allowance for coding tasks. The native program must be able to complete a task with more than eight valid tool rounds under its normal token budget. Source-level resumption / an explicit budget-exhausted outcome would also be useful for owning task recovery.

## Reduced reproduction recipe

The integrated failure above is directly observed. The following standalone recipe is reduced from it and has not been executed separately, to avoid redundant testing. Use a dependency-free edition-2026 package with source root `src`, bin module `app.main` / flow `main`, local static rules `console=allow`, `model=allow`, `tool=allow`, and an OpenAI model at `http://127.0.0.1:18097/v1`, `allow_private=true`, `typed_output_encoding="output-tool"`, API key environment `SYNTHETIC_KEY`, retry attempts 1.

```etas
module app.main;

import std.io.println;

type Answer = { text: string };

public tool tick(value: i32) -> i32 ![] { return value + 1; }

@tools([tick])
@limits([Tokens(131072), ContextTokens(1048576)])
agent Worker(input: string) -> Answer {
    return perform infer<Answer>(Prompt.new().system(Trusted("Call tick nine times, then return the answer.")).data(input));
}

flow main(args: Array<string>) -> i32 ![Agentic, Console, Error<IOError>] {
    let answer = Worker.run("Complete all nine tool rounds.");
    println(answer.text);
    return 0;
}
```

Run this local synthetic model in the same network namespace, then `SYNTHETIC_KEY=synthetic etas run . --allow-effects`:

```python
"""Local synthetic replies only; no upstream provider or real credential."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Model(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        index = Model.calls
        Model.calls += 1
        name = 'tick' if index < 9 else 'etas_emit_output'
        assert any(tool['function']['name'] == name for tool in request['tools'])
        arguments = {'value': index} if index < 9 else {'text': 'All nine tools completed.'}
        body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': None,
            'tool_calls': [{'id': f'call-{index}', 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}]},
            'finish_reason': 'tool_calls'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(('127.0.0.1', 18097), Model).serve_forever()
```

Expected: nine valid native tool calls followed by the final typed answer. The application has not patched the interpreter, added a Python dispatcher, or split its requested task to avoid the native round limit.
