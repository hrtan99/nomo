module nomo.adapters.model.context_projection;

import std.text.len as text_bytes;
import nomo.domain.serialization.json.encode;
import nomo.domain.conversation.turn.Turn;
import nomo.application.context.ports.ContextProjection;
import nomo.domain.context.projection.should_compact;

public type RollingContext = {};

impl RollingContext ~ ContextProjection {
    flow bytes(self, input: Turn) -> usize {
        let json = match encode(input, "context conversion failed", "context encoding failed") {
            Ok(value) => value, Err(error) => { abort(error); }
        };
        return text_bytes(json);
    }
    flow needs_compaction(self, input: Turn) -> bool {
        return should_compact(input, self.bytes(input));
    }
}
