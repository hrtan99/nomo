module nomo.adapters.cli.edit_input;

import nomo.domain.editing.{Selector, selector_error, text_bytes};
import nomo.domain.harness.edit.text_error;
import nomo.domain.harness.loop.{allowed_error, question_error as loop_question_error};
import nomo.domain.harness.read.question_error;
import nomo.domain.sessions.work.WorkRequest;
import nomo.domain.text.within;
import std.text.split;

public type Options = {
    help: bool,
    id: string,
    workspace: string,
    path: string,
    target: string,
    replacement: string
};

public flow edit_args_parse(args: Array<string>, applying: bool) -> Result<Options, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Options {
            help = true,
            id = "",
            workspace = "",
            path = "",
            target = "",
            replacement = ""
        });
    }
    let expected: usize = if applying {
        10
    } else {
        6
    };
    if args.len() != expected {
        return Err("expected --id ID --workspace BIND --path FILE and apply --target TEXT --replacement TEXT");
    }
    var id = "";
    var workspace = "";
    var path = "";
    var target = "";
    var replacement = "";
    var seen: Array<string> = [];
    var index: usize = 0;
    @limits([Iterations(5)]) while index < args.len() {
        let flag = args[index];
        if seen.iter().any(previous => previous == flag) {
            return Err("duplicate edit option");
        }
        seen = seen.push(flag);
        let value = args[index + 1];
        match flag {
            "--id" => {
                id = value;
            }
            "--workspace" => {
                workspace = value;
            }
            "--path" => {
                path = value;
            }
            "--target" => {
                if !applying {
                    return Err("unknown edit option");
                }
                target = value;
            }
            "--replacement" => {
                if !applying {
                    return Err("unknown edit option");
                }
                replacement = value;
            }
            _ => {
                return Err("unknown edit option");
            }
        }
        index = index + 2;
    }
    let invalid = selector_error(id, workspace, path);
    if invalid != "" {
        return Err(invalid);
    }
    if applying {
        let size = match text_bytes(target, "target") {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        match text_bytes(replacement, "replacement") {
            Ok(_) => (),
            Err(error) => {
                return Err(error);
            }
        }
        if size == 0 {
            return Err("target must not be empty");
        }
    }
    return Ok(Options {
        help = false,
        id,
        workspace,
        path,
        target,
        replacement
    });
}

public type Input = {
    help: bool,
    id: string,
    workspace: string,
    path: string,
    request: string
};

public flow harness_edit_args_parse(args: Array<string>) -> Result<Input, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Input {
            help = true,
            id = "",
            workspace = "",
            path = "",
            request = ""
        });
    }
    if args.len() != 8 {
        return Err("expected --id ID --workspace BIND --path FILE --once TASK");
    }
    var id = "";
    var workspace = "";
    var path = "";
    var request = "";
    var seen: Array<string> = [];
    var index: usize = 0;
    @limits([Iterations(4)]) while index < args.len() {
        let flag = args[index];
        if seen.iter().any(previous => previous == flag) {
            return Err("duplicate harness edit option");
        }
        seen = seen.push(flag);
        let value = args[index + 1];
        match flag {
            "--id" => {
                id = value;
            }
            "--workspace" => {
                workspace = value;
            }
            "--path" => {
                path = value;
            }
            "--once" => {
                request = value;
            }
            _ => {
                return Err("unknown harness edit option");
            }
        }
        index = index + 2;
    }
    let selected = selector_error(id, workspace, path);
    if selected != "" {
        return Err(selected);
    }
    let invalid = text_error(request, "edit task");
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(Input {
        help = false,
        id,
        workspace,
        path,
        request
    });
}

public type Work = {
    edit: Input,
    allowed: Array<string>
};

flow parse_with(args: Array<string>, unicode: bool) -> Result<Work, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        let edit = match harness_edit_args_parse(args) {
            Ok(value) => value,
            Err(error) => {
                return Err(error);
            }
        };
        return Ok(Work {
            edit,
            allowed = []
        });
    }
    if args.len() != 10 {
        return Err("expected --id ID --workspace BIND --path FILE --once TASK --allow FILE[,FILE]");
    }
    var selected: Array<string> = [];
    var supplied = false;
    var raw = "";
    var index: usize = 0;
    @limits([Iterations(5)]) while index < args.len() {
        let flag = args[index];
        let value = args[index + 1];
        if flag == "--allow" {
            if supplied {
                return Err("duplicate --allow option");
            }
            supplied = true;
            raw = value;
        } else {
            selected = selected.push(flag).push(value);
        }
        index = index + 2;
    }
    var maximum: usize = 97;
    if unicode {
        maximum = 195;
    }
    if !supplied || !within(raw, maximum) {
        return Err("expected one bounded --allow FILE[,FILE]");
    }
    let edit = match harness_edit_args_parse(selected) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let request = if unicode {
        question_error(edit.request)
    } else {
        loop_question_error(edit.request)
    };
    if request != "" {
        return Err(request);
    }
    let allowed = split(raw, ",");
    if !unicode && allowed.len() > 2 {
        return Err("legacy work supports at most two allowed files");
    }
    let invalid = allowed_error(allowed);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(Work {
        edit,
        allowed
    });
}

public flow harness_work_args_parse(args: Array<string>) -> Result<Work, string> {
    return parse_with(args, false);
}

public flow parse_unicode(args: Array<string>) -> Result<Work, string> {
    return parse_with(args, true);
}

public flow application(value: Work) -> WorkRequest {
    return WorkRequest {
        selected = Selector {
            id = value.edit.id,
            workspace = value.edit.workspace,
            path = value.edit.path
        },
        request = value.edit.request,
        allowed = value.allowed,
    };
}

// Share bounded work/check argument decoding while retaining caller-specific admission rules.
public type RecordedWork = {
    input: Work,
    has_check: bool,
    digest: string
};

public flow parse_recorded(args: Array<string>, trailer: usize, reject_empty: bool) -> Result<
    RecordedWork,
    string
> {
    if args.len() < trailer {
        return Err("invalid work argument trailer");
    }
    let end = args.len() - trailer;
    let has_check = end >= 2 && args[end - 2] == "--check-ref";
    let digest = if has_check {
        args[end - 1]
    } else {
        ""
    };
    if has_check && reject_empty && digest == "" {
        return Err("invalid check reference");
    }
    let limit = if has_check {
        end - 2
    } else {
        end
    };
    let selected = args.iter().take(limit).collect();
    let input = match parse_unicode(selected) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(RecordedWork {
        input,
        has_check,
        digest
    });
}
