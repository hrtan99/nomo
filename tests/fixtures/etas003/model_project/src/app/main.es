module app.main;

@limits([Tokens(256)])
agent ModelProbe(input: string) -> string
{
    return Prompt.new()
        .system(Trusted("Reply with exactly ETAS003_OK and no other text."))
        .data(input);
}

flow main(args: Array<string>) -> i32
{
    let response = ModelProbe.run("ETAS003_PROBE");
    if response == "ETAS003_MOCK_OK" {
        return 0;
    }
    if response == "ETAS003_OK" {
        return 0;
    }
    return 2;
}
