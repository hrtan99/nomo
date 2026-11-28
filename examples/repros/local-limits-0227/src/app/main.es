module app.main;

public flow main() -> i32 {
    var index: i32 = 0;
    @limits([Iterations(3)])
    while index < 3 {
        index = index + 1;
    }
    return index;
}
