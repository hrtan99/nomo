module nomo.domain.execution.checks;

import nomo.domain.execution.command.CommandOutput;

public type CheckOutcome = { configured: bool, output: Array<CommandOutput> };
