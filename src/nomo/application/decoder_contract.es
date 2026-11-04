module nomo.application.decoder_contract;

public type EditText = { target: string, replacement: string };
public spec ReadPlanDecoder {
    flow decode(self, raw: string) -> Result<string, string> ![Error<IndexError>];
}
public spec EditProposalDecoder {
    flow decode(self, raw: string) -> Result<EditText, string> ![Error<IndexError>];
}
