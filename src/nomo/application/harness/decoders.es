module nomo.application.harness.decoders;

import nomo.domain.mutations.edit_text.EditText;

public spec ReadPlanDecoder {
    flow decode(self, raw: string) -> Result<string, string> ![Error<IndexError>];
}

public spec EditProposalDecoder {
    flow decode(self, raw: string) -> Result<EditText, string> ![Error<IndexError>];
}
