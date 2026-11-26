module nomo.adapters.cli.legacy.read_model_tools_chat;

import nomo.adapters.cli.legacy.model_tools_chat_loop.run_mode;

public flow run(args: Array<string>) -> i32 { return run_mode(args, true); }
