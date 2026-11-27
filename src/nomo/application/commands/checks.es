module nomo.application.commands.checks;

import nomo.application.commands.requests.execute;
import nomo.application.configuration.context.SettingsContext;
import nomo.domain.execution.checks.CheckOutcome;

flow program_path(name: string) -> string {
    return match name { "python3" => "/usr/bin/python3", "git" => "/usr/bin/git", "sh" => "/bin/sh", _ => name };
}

public flow run() -> CheckOutcome {
    let settings = perform SettingsContext.current();
    var program = "";
    var arguments: Array<string> = [];
    for value in settings.check {
        if program == "" { program = value; } else { arguments = arguments.push(value); }
    }
    if program == "" { return CheckOutcome { configured = false, output = [] }; }
    return CheckOutcome { configured = true, output = [execute(program_path(program), arguments)] };
}
