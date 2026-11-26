module nomo.domain.harness.history_continue_model;

import nomo.domain.sessions.facts.{WorkFacts, BudgetFacts};
import nomo.domain.harness.harness_tool_chat_contract.Context;
import nomo.core.conversation.Event;

// Durable results are untrusted prior data. They are never an approval, a
// current filesystem observation, or a reason to replay a completed action.
public type Input = { current: Context, work: WorkFacts, history: Array<Event> };

public type FollowupInput = { current: Context, work: WorkFacts, followup: WorkFacts, additional: Array<WorkFacts>, history: Array<Event>, budget: BudgetFacts };
