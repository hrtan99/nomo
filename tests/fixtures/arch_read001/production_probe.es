module app.production_probe;

import nomo.domain.workspace.Outcome;
import nomo.application.resources.ReadOnlyRoot;
import nomo.adapters.filesystem.workspace.read_file;
import nomo.adapters.filesystem.workspace.search_files;
import nomo.domain.harness.loop.Limits;
import nomo.domain.harness.loop.fresh_loop;
import nomo.bootstrap.harness.model_tool_run_loop as run_loop;

public flow production_read(args: Array<string>) -> i32 {
    let result: Outcome = read_file("a.txt");
    return 0;
}
public flow production_search(args: Array<string>) -> i32 {
    let result: Outcome = search_files(["a.txt", "b.txt"], "blue");
    return 0;
}
public flow production_loop(args: Array<string>) -> i32 {
    let limits = Limits { steps = 3, calls = 2, tokens = 4096, scan = 4096 };
    let result = run_loop("Task", ["a.txt"], limits, fresh_loop());
    return result.status;
}
