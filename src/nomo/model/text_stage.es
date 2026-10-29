module nomo.model.text_stage;

import nomo.core.conversation.Event;

// Copied conversation data only. The caller owns the attempt and its budget.
public type Context = { history: Array<Event>, request: string };
public spec TextModelStage: callable Context => string ![];
public effect ModelText { action infer(context: Context) -> string; }
