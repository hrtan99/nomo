module nomo.application.context.effects.tools_read_contract;

import nomo.domain.context.read_contract.Outcome;

public effect ReadTools {
    action read(name: string) -> Outcome;
    action search(names: Array<string>, literal: string) -> Outcome;
}
