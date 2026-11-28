module app.main;

import nomo.bootstrap.harness.run_text;
import std.io.IOError;

public flow main(args: Array<string>) -> i32 ![Agentic, Console, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] { return run_text("alpha"); }
