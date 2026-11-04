module nomo.application.work.request;

import nomo.tools.edit_contract.Selector;

// Application input after CLI parsing. Help flags, option spelling and command
// trailers stay in presentation modules.
public type WorkRequest = { selected: Selector, request: string, allowed: Array<string> };
