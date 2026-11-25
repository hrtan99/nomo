module repro.domain.command;
public type Request = { program: string, arguments: Array<string>, stdin: Option<bytes> };
