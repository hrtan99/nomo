module app.main;

@limits([Tokens(64)])
agent ModelProbe(input: string) -> string
{
    return Prompt.new()
        .system(Trusted("Return one short response."))
        .data(input);
}

flow main(args: Array<string>) -> i32
{
    let response = ModelProbe.run("MODEL_DEADLINE_REPRO");
    if response == "" {
        return 1;
    }
    return 0;
}
