module nomo.harness.harness_work_contract;

import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_edit_contract.Ledger as EditLedger;

public type Ledger = {
    read: ReadLedger,
    edit: EditLedger
};
