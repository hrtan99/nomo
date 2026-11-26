module nomo.adapters.filesystem.configuration.converter;

import nomo.application.commands.effects.CommandOperations;
import std.io.IOError as ConsoleError;
import nomo.application.configuration.ports.TomlConverter;
import nomo.domain.configuration.conversion.{Converted, ConfigurationOutput};
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.commands.requests.execute_readonly_input;

public type TaploConfigurationConverter = {};
impl TaploConfigurationConverter ~ TomlConverter {
    flow toml(self, raw: string) -> Converted ![SessionContext, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
        let value = execute_readonly_input("project_configuration", "/home/nomo/.cargo/nomo-native-tools/taplo-0.10.0/bin/taplo", ["get", "-o", "json"], raw);
        return Converted { result_event = value.result_event, output = ConfigurationOutput { exit_code = value.output.exit_code, stdout = value.output.stdout, stderr = value.output.stderr } };
    }
    flow entries(self, json: string) -> Converted ![SessionContext, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
        let value = execute_readonly_input("configuration_entries", "/usr/bin/jq", ["-c", "walk(if type == \"object\" then to_entries else . end)"], json);
        return Converted { result_event = value.result_event, output = ConfigurationOutput { exit_code = value.output.exit_code, stdout = value.output.stdout, stderr = value.output.stderr } };
    }
}
