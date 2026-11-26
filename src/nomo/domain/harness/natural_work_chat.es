module nomo.domain.harness.natural_work_chat;

import nomo.domain.harness.harness_tool_chat_contract.Context;
import nomo.domain.sessions.facts.WorkFacts;
import nomo.core.conversation.Event;

public type Input = { current: Context, history: Array<Event>, work: Option<WorkFacts>, followup: Option<WorkFacts>, additional: Array<WorkFacts>, page: usize, more_pages: bool };

public type Decision = { action: string, path: string, command: Array<string>, answer: string };
