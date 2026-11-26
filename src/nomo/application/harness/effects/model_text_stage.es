module nomo.application.harness.effects.model_text_stage;

import nomo.domain.harness.text_stage.Context;

public effect ModelText { action infer(context: Context) -> string; }
