module nomo.adapters.cli.conversation_picker;

import std.io.{println, print, read_line, IOError as ConsoleError};
import std.text.{trim, from_usize, parse_usize};
import nomo.domain.conversation.session.Session;
import nomo.application.conversation.ports.ConversationPicker;

public type ConsoleConversationPicker = {};
impl ConsoleConversationPicker ~ ConversationPicker {
    flow choose(self, sessions: Array<Session>) -> Option<string> ![Console, Error<ConsoleError>] {
        var number: usize = 1;
        for item in sessions {
            println("[SESSION] " + from_usize(number) + " · " + item.id + " · " + item.title);
            println("          " + item.workspace);
            number = number + 1;
        }
        print("Conversation number or ID (empty cancels): ");
        let selected = trim(read_line());
        if selected == "" { return None(); }
        match parse_usize(selected) {
            Ok(index) => {
                number = 1;
                for item in sessions {
                    if number == index { return Some(item.id); }
                    number = number + 1;
                }
                abort("conversation number is not in the displayed list");
            }
            Err(_) => { return Some(selected); }
        }
    }
}
