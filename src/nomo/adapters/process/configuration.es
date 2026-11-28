module nomo.adapters.process.configuration;

import nomo.application.execution.commands.execute_readonly_input;
import nomo.application.execution.ports.CommandOperations;
import nomo.application.scope.SessionContext;
import nomo.application.workspace.ports.{ConfigurationOutput, Converted, TomlConverter};
import std.io.IOError;

public type TaploConfigurationConverter = {};

impl TaploConfigurationConverter ~ TomlConverter {
    flow toml(self, session: string, raw: string) -> Converted ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<BudgetExceeded>
    ] {
        let value = handle execute_readonly_input(
            "project_configuration",
            "/home/nomo/.cargo/nomo-native-tools/taplo-0.10.0/bin/taplo",
            ["get", "-o", "json"],
            raw
        ) with {
            SessionContext.current() => session;
        };
        return Converted {
            result_event = value.result_event,
            output = ConfigurationOutput {
                exit_code = value.output.exit_code,
                stdout = value.output.stdout,
                stderr = value.output.stderr
            }
        };
    }

    flow entries(self, session: string, json: string) -> Converted ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<BudgetExceeded>
    ] {
        let value = handle execute_readonly_input(
            "configuration_entries",
            "/usr/bin/jq",
            ["-c", "walk(if type == \"object\" then to_entries else . end)"],
            json
        ) with {
            SessionContext.current() => session;
        };
        return Converted {
            result_event = value.result_event,
            output = ConfigurationOutput {
                exit_code = value.output.exit_code,
                stdout = value.output.stdout,
                stderr = value.output.stderr
            }
        };
    }
}
