module nomo.core.conversation;



public type Event = {
    role: string,
    kind: string,
    name: string,
    text: string
};

public type State = {
    events: Array<Event>,
    characters: usize,
    spent: i32,
    stopped: bool
};
