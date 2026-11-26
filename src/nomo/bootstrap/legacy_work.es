module nomo.bootstrap.legacy_work;

import nomo.adapters.filesystem.legacy_work_editor.LegacyWorkEditor;
import nomo.adapters.storage.legacy_work_timeline.LegacyWorkTimeline;
import nomo.adapters.cli.legacy_work_output.LegacyWorkOutput;

public flow legacy_editor() -> LegacyWorkEditor { return LegacyWorkEditor {}; }
public flow legacy_timeline() -> LegacyWorkTimeline { return LegacyWorkTimeline {}; }
public flow legacy_output() -> LegacyWorkOutput { return LegacyWorkOutput {}; }
