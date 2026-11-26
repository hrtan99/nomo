module nomo.application.harness.effects.harness_edit_original;



public effect EditOriginal { action read(path: string) -> Result<string, string>; }
