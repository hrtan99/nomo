module nomo.domain.projects.planner;

import nomo.domain.projects.contracts.{Context, Tool};

public type StepInput = { context: Context, tools: Array<Tool> };

public type Summary = { text: string };
