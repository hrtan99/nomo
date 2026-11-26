module nomo.adapters.cli.arguments.harness_work_args;

import nomo.domain.text.read_text.within;
import std.text.split;
import nomo.adapters.cli.arguments.harness_edit_args.{Input, parse as edit_args};
import nomo.domain.harness.model_tool_contract.question_error;
import nomo.domain.harness.tool_context.allowed_error;
import nomo.domain.harness.read_protocol.question_error as unicode_question_error;
import nomo.application.work.request.WorkRequest;
import nomo.domain.mutations.edit_contract.Selector;

public type Work = { edit: Input, allowed: Array<string> };

flow parse_with(args: Array<string>, unicode: bool) -> Result<Work, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        let edit = match edit_args(args) { Ok(value) => value, Err(error) => { return Err(error); } };
        return Ok(Work { edit, allowed = [] });
    }
    if args.len() != 10 { return Err("expected --id ID --workspace BIND --path FILE --once TASK --allow FILE[,FILE]"); }
    var selected: Array<string> = []; var supplied = false; var raw = ""; var index: usize = 0;
    @limits([Iterations(5)]) while index < args.len() {
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
    if !unicode && allowed.len() > 2 { return Err("legacy work supports at most two allowed files"); }
    let invalid = allowed_error(allowed); if invalid != "" { return Err(invalid); }
    return Ok(Work { edit, allowed });
}
public flow parse(args: Array<string>) -> Result<Work, string> { return parse_with(args, false); }
public flow parse_unicode(args: Array<string>) -> Result<Work, string> { return parse_with(args, true); }

public flow application(value: Work) -> WorkRequest {
    return WorkRequest {
        selected = Selector { id = value.edit.id, workspace = value.edit.workspace, path = value.edit.path },
        request = value.edit.request,
        allowed = value.allowed,
    };
}

// Share bounded work/check argument decoding while retaining caller-specific admission rules.
public type RecordedWork = { input: Work, has_check: bool, digest: string };
public flow parse_recorded(args: Array<string>, trailer: usize, reject_empty: bool) -> Result<RecordedWork, string> {
    if args.len() < trailer { return Err("invalid work argument trailer"); }
    let end = args.len() - trailer;
    let has_check = end >= 2 && args[end - 2] == "--check-ref";
    let digest = if has_check { args[end - 1] } else { "" };
    if has_check && reject_empty && digest == "" { return Err("invalid check reference"); }
    let limit = if has_check { end - 2 } else { end };
    var selected: Array<string> = []; var index: usize = 0;
    @limits([Iterations(32)]) while index < limit { selected = selected.push(args[index]); index = index + 1; }
    let input = match parse_unicode(selected) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(RecordedWork { input, has_check, digest });
}
