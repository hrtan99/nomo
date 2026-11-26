module nomo.domain.harness.history_followup_model;

import nomo.core.conversation.Event;
import nomo.domain.harness.harness_tool_contract.Context as ReadContext;
import nomo.domain.harness.harness_work_contract.Context as WorkContext;
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.domain.sessions.facts.CheckOutput;

// Previous conversation is data, not a current observation, grant or receipt.
public type HistoryWork = { id: string, summary: string, summary_source: string, selection: Option<string>, check: string, exit_code: string };

public type PriorWork = { request: string, summary: string, summary_source: string, selection: Option<string>, check: string, exit_code: string, output: Option<CheckOutput>, history: Array<HistoryWork> };

public type ReadWork = { id: string, selection: Option<string> };

public type ReadPriorWork = { request: string, summary: string, summary_source: string, selection: Option<string>, check: string, history: Array<ReadWork> };

public type ReadInput = { current: ReadContext, previous_request: string, previous: Previous, conversation: Array<Event>, prior_work: ReadPriorWork };

public type EditInput = { current: WorkContext, previous_request: string, previous: Previous, conversation: Array<Event>, prior_work: PriorWork };
