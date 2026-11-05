module nomo.entry.read_model_tools_chat;

import nomo.entry.model_tools_chat_loop.run_mode;

public flow run(args: Array<string>) -> i32 { return run_mode(args, true); }
