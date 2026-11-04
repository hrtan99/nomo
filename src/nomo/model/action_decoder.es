module nomo.model.action_decoder;

import std.text.{trim, len, starts_with};
import nomo.model.model_tool_contract.{Action, decode_reply, decode_work_reply};
import nomo.model.read_protocol.{decode_child, compact_frame};
import nomo.harness.model_plan_diagnostic.response_error;

public spec ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> ![Error<IndexError>];
    flow record(self, raw: string) -> string ![Error<IndexError>];
}
public type LegacyActions = { work: bool };
public type UnicodeActions = {};
impl LegacyActions ~ ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
        return if self.work { decode_work_reply(raw, allowed, final_only) } else { decode_reply(raw, allowed, final_only) };
    }
    flow record(self, raw: string) -> string ![] { return raw; }
}
impl UnicodeActions ~ ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
        return match decode_child(raw, allowed, final_only) {
            Ok(value) => Ok(value),
            Err(error) => {
                let text = trim(raw);
                let category = if len(raw) > 1152 { "limit" } else { if starts_with(text, "```") { "fence" } else { if starts_with(text, "{") { "object" } else { if starts_with(text, "[") { "frame" } else { "prose" } } } };
                return Err(error + "; " + response_error(raw, if final_only { "read-child-final" } else { "read-child-action" }, category, 1152));
            }
        };
    }
    flow record(self, raw: string) -> string { return compact_frame(raw); }
}
