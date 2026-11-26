module nomo.adapters.model.tools.projects;

import nomo.application.projects.effects.ProjectOperations;

public flow remember(workspace: string) -> unit ![ProjectOperations] { perform ProjectOperations.remember(workspace); }

public flow show_projects() -> unit ![ProjectOperations] { perform ProjectOperations.show(); }

public flow request_open(raw: string, workspace: string) -> bool ![ProjectOperations] { return perform ProjectOperations.open(raw, workspace); }
