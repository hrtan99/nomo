module nomo.domain.work.protocol;

import nomo.domain.harness.harness_work_contract.{Context, Evidence};
import nomo.harness.harness_work_contract.Ledger;
import nomo.domain.mutations.edit_contract.{Selector, Prepared};

public type Failure = { state: Ledger, error: string };

public type Pending = { selected: Selector, prepared: Prepared, evidence: Evidence, request: string, task: string, state: Ledger, high_input: bool };

public type Completed = { context: Context, state: Ledger, high_input: bool };

public type Summary = { answer: string, state: Ledger, model_generated: bool };
