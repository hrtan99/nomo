module nomo.harness.harness_work_contract;

import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_edit_contract.Ledger as EditLedger;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type Ledger = {
    read: ReadLedger,
    edit: EditLedger
};
