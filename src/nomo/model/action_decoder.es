module nomo.model.action_decoder;

import std.text.{trim, char_count as len, starts_with};
import nomo.model.model_tool_contract.{Action, decode_reply, decode_work_reply};
import nomo.model.read_protocol.{decode_child, compact_frame};
import nomo.harness.model_plan_diagnostic.response_error;

public spec ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> ![Error<IndexError>];
    flow record(self, raw: string) -> string ![Error<IndexError>];
    flow diagnostic(self, raw: string, error: string, final_only: bool) -> string ![];
}
public type LegacyActions = { work: bool };
public type UnicodeActions = {};
impl LegacyActions ~ ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
        return if self.work { decode_work_reply(raw, allowed, final_only) } else { decode_reply(raw, allowed, final_only) };
    }
    flow record(self, raw: string) -> string ![] { return raw; }
    flow diagnostic(self, raw: string, error: string, final_only: bool) -> string ![] { return ""; }
}
flow unicode_category(raw: string, error: string) -> string {
    let text = trim(raw);
    if len(raw) > 1152 { return "limit"; }
    if starts_with(text, "```") { return "fence"; }
    if starts_with(text, "{") { return "object"; }
    if !starts_with(text, "[") { return "prose"; }
    if error == "invalid action field count" || error == "child final must contain exactly two fields" { return "arity"; }
    if error == "second response must be final" || error == "unsupported action or arity" { return "verb"; }
    if error == "child final exceeds 256 UTF-8 bytes" || error == "child final contains unsupported control or formatting characters or is empty" { return "result"; }
    if error == "invalid search literal" { return "literal"; }
    return "frame";
}
impl UnicodeActions ~ ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
        return match decode_child(raw, allowed, final_only) {
            Ok(value) => Ok(value),
            Err(error) => {
                return Err(error + "; " + self.diagnostic(raw, error, final_only));
            }
        };
    }
    flow record(self, raw: string) -> string { return compact_frame(raw); }
    flow diagnostic(self, raw: string, error: string, final_only: bool) -> string {
        return response_error(raw, if final_only { "read-child-final" } else { "read-child-action" }, unicode_category(raw, error), 1152);
    }
}
