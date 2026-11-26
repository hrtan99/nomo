module nomo.adapters.model.prompt_encoding;

import std.agent.prompt.{PromptEncode, PromptPart};
import nomo.domain.serialization.json.encode as encode_json;

// Keep framework encoding at the model boundary; domain and stored types stay passive.
public type JsonInput<T> = { value: T };

impl JsonInput<T> ~ PromptEncode {
    public flow encode(self) -> PromptPart ![] {
        let text = match encode_json(self.value, "model input conversion failed", "model input JSON encoding failed") {
            Ok(text) => text,
            Err(error) => abort(error),
        };
        return PromptPart { text };
    }
}

public flow input<T>(value: T) -> JsonInput<T> ![] { return JsonInput { value }; }
