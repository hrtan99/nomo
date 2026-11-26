module nomo.adapters.model.decoders;

import nomo.application.harness.decoders.{ReadPlanDecoder, EditProposalDecoder};
import nomo.domain.mutations.edit_text.EditText;
import nomo.domain.harness.harness_model_contract.AsciiReadPlan as PureAsciiReadPlan;
import nomo.domain.harness.read_protocol.Utf8ReadPlan as PureUtf8ReadPlan;
import nomo.domain.harness.harness_edit_contract.EditProposal as PureEditProposal;

public type AsciiReadPlan = { compatible: bool };

impl AsciiReadPlan ~ ReadPlanDecoder {
    flow decode(self, raw: string) -> Result<string, string> {
        let decoder = PureAsciiReadPlan { compatible = self.compatible };
        return decoder.decode(raw);
    }
}


public type Utf8ReadPlan = { work: bool };

impl Utf8ReadPlan ~ ReadPlanDecoder {
    flow decode(self, raw: string) -> Result<string, string> {
        let decoder = PureUtf8ReadPlan { work = self.work };
        return decoder.decode(raw);
    }
}


public type EditProposal = { diagnostic: bool, empty: bool };

impl EditProposal ~ EditProposalDecoder {
    flow decode(self, raw: string) -> Result<EditText, string> {
        let decoder = PureEditProposal { diagnostic = self.diagnostic, empty = self.empty };
        return decoder.decode(raw);
    }
}
