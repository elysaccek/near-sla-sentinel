pub(crate) fn slot_mask(slot_count: u8) -> u64 {
    u64::MAX >> (64 - slot_count)
}

fn longest_run(mut mask: u64) -> u8 {
    let mut length = 0;
    while mask != 0 {
        mask &= mask << 1;
        length += 1;
    }
    length
}

pub(crate) fn down_streak_bounds(up: [u64; 3], down: [u64; 3], slot_count: u8) -> (u8, u8) {
    let valid = slot_mask(slot_count);
    let mut confirmed_down = 0;
    let mut possible_down = 0;
    for (a, b) in [(0, 1), (0, 2), (1, 2)] {
        confirmed_down = confirmed_down.max(longest_run(down[a] & down[b]));
        possible_down = possible_down.max(longest_run(valid & !(up[a] | up[b])));
    }
    (confirmed_down, possible_down)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_two_oracles_must_confirm_the_entire_streak() {
        let up = [0b10001, 0b10001, 0b10001];
        let down = [0b00110, 0b01110, 0b01100];
        assert_eq!(down_streak_bounds(up, down, 5), (2, 3));
        assert_eq!(
            down_streak_bounds(up, [0b01110, 0b01110, 0b01100], 5),
            (3, 3)
        );
    }

    #[test]
    fn shifted_streaks_cannot_corroborate_their_nonoverlapping_slots() {
        assert_eq!(down_streak_bounds([0; 3], [0b00111, 0b11100, 0], 5), (1, 5));
    }

    #[test]
    fn healthy_slots_break_even_a_possible_outage() {
        assert_eq!(down_streak_bounds([0b00100, 0b00100, 0], [0; 3], 5), (0, 2));
    }

    #[test]
    fn missing_and_conflicting_votes_leave_uncertainty() {
        assert_eq!(down_streak_bounds([0b111, 0, 0], [0, 0b111, 0], 3), (0, 3));
    }

    #[test]
    fn all_sixty_four_slots_are_representable() {
        assert_eq!(
            down_streak_bounds([0; 3], [u64::MAX, u64::MAX, 0], 64),
            (64, 64)
        );
    }
}
