module nomo.application.commands.checks;

import nomo.application.commands.requests.execute;
import nomo.application.configuration.context.SettingsContext;
import nomo.domain.execution.checks.CheckOutcome;

flow program_path(name: string) -> string {
    return match name { "python3" => "/usr/bin/python3", "git" => "/usr/bin/git", "sh" => "/bin/sh", _ => name };
}

public flow run() -> CheckOutcome {
    let settings = perform SettingsContext.current();
    let command = settings.check.iter().skip_while(value => value == "");
    return match command.nth(0) {
        None() => CheckOutcome { configured = false, output = [] },
        Some(program) => CheckOutcome {
            configured = true, output = [execute(program_path(program), command.skip(1).collect())]
        },
    };
}
