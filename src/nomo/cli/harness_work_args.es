module nomo.cli.harness_work_args;

import nomo.core.read_text.within;
import std.collections.len as count;
import std.text.{split};
import nomo.cli.harness_edit_args.Input;
import nomo.cli.harness_edit_args.parse as edit_args;
import nomo.model.model_tool_contract.{question_error, allowed_error};
import nomo.model.read_protocol.question_error as unicode_question_error;

public type Work = { edit: Input, allowed: Array<string> };

flow parse_with(args: Array<string>, unicode: bool) -> Result<Work, string> {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") {
        let edit = match edit_args(args) { Ok(value) => value, Err(error) => { return Err(error); } };
        return Ok(Work { edit = edit, allowed = [] });
    }
    if count(args) != 10 { return Err("expected --id ID --workspace BIND --path FILE --once TASK --allow FILE[,FILE]"); }
    var selected: Array<string> = []; var supplied = false; var raw = ""; var index: usize = 0;
    while index < count(args) limit Iterations(5) {
        let flag = args[index]; let value = args[index + 1];
        if flag == "--allow" {
            if supplied { return Err("duplicate --allow option"); }
            supplied = true; raw = value;
        } else { selected = selected.push(flag).push(value); }
        index = index + 2;
    }
    var maximum: usize = 97; if unicode { maximum = 195; }
    if !supplied || !within(raw, maximum) { return Err("expected one bounded --allow FILE[,FILE]"); }
    let edit = match edit_args(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    let request = if unicode { unicode_question_error(edit.request) } else { question_error(edit.request) }; if request != "" { return Err(request); }
    let allowed = split(raw, ",");
    if !unicode && count(allowed) > 2 { return Err("legacy work supports at most two allowed files"); }
    let invalid = allowed_error(allowed); if invalid != "" { return Err(invalid); }
    return Ok(Work { edit = edit, allowed = allowed });
}
public flow parse(args: Array<string>) -> Result<Work, string> { return parse_with(args, false); }
public flow parse_unicode(args: Array<string>) -> Result<Work, string> { return parse_with(args, true); }
