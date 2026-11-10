module app.main;

import std.io.println;

type Answer = { text: string };

public tool tick(value: i32) -> i32 ![] { return value + 1; }

@tools([tick])
@limits([Tokens(131072), ContextTokens(1048576)])
agent Worker(input: string) -> Answer {
    return perform infer<Answer>(Prompt.new().system(Trusted("Call tick nine times, then return the answer.")).data(input));
}

flow main(args: Array<string>) -> i32 ![Agentic, Console, Error<IOError>] {
    let answer = Worker.run("Complete all nine tool rounds.");
    println(answer.text);
    return 0;
}
