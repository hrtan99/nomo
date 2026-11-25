module app.main;

flow main(args: Array<string>) -> i32 {
    var total = 0;
    @limits([Iterations(3)])
    for value in [1, 2, 3] {
        total = total + value;
    }
    return total;
}
