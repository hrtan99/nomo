module nomo.session.chat_format_policy;

public type Reservation = { calls: i32, generation: i32 };

public spec ChatFormatPolicy {
    flow pending_reservation(self, phase: string) -> Reservation ![];
    flow turn_limit(self) -> i32 ![];
    flow continuation_rule(self, admitted: i32) -> bool ![];
    flow history_rule(self, admitted: i32, event_format: i32) -> bool ![];
}

public type FormatPolicy = { format: i32 };
impl FormatPolicy ~ ChatFormatPolicy {
    flow pending_reservation(self, phase: string) -> Reservation ![] {
        if phase != "running" { return Reservation { calls = 0, generation = 0 }; }
        let calls = if self.format >= 5 { 6 } else { 4 };
        let generation = if self.format == 16 { 405504 } else { if self.format == 15 { 278528 } else {
            if self.format >= 11 { 24576 } else { if self.format >= 9 { 20480 } else { if self.format >= 5 { 12288 } else { 8192 } } }
        } };
        return Reservation { calls = calls, generation = generation };
    }
    flow turn_limit(self) -> i32 ![] {
        if self.format >= 14 { return 48; }
        return if self.format == 4 || self.format == 5 || self.format == 7 || self.format == 9 || self.format == 11 || self.format == 13 { 32 } else { 2 };
    }
    flow continuation_rule(self, admitted: i32) -> bool ![] { return admitted < self.turn_limit(); }
    flow history_rule(self, admitted: i32, event_format: i32) -> bool ![] { return admitted >= 2 || event_format == 2; }
}

public flow policy(format: i32) -> FormatPolicy { return FormatPolicy { format = format }; }
