module nomo.application.edit.effects;

// Native approval is requested by the application and handled by the selected
// terminal/runtime adapter for the current invocation.
public effect Approval { action request(reason: string) -> bool; }
