module etas002.runtime_failure;

flow recurse(value: i32) -> i32
{
    return 1 + recurse(value + 1);
}

flow main(args: Array<string>) -> i32
{
    return recurse(0);
}
