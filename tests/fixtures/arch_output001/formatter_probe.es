module app.formatter_probe;

import nomo.core.conversation.Event;
import nomo.agent.console_events.publish;

public flow observe(args: Array<string>) -> i32 {
    __EVENTS__
    return 0;
}
