#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Default)]
pub struct VoteMasks {
    pub up: u64,
    pub down: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Breach,
    Healthy,
    Inconclusive,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Assessment {
    pub outcome: Outcome,
    pub confirmed: u8,
    pub possible: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidWindow {
    SlotCount,
    DownThreshold,
    Quorum,
    VoteMasks,
}

fn slot_mask(length: u8) -> u64 {
    u64::MAX >> (64 - length)
}

fn longest_supported_run(
    votes: &[Option<VoteMasks>],
    slot_count: u8,
    quorum: usize,
    supports: impl Fn(VoteMasks, u64) -> bool,
) -> u8 {
    // Any supported range also contains a supported shorter range.
    let mut lower = 0;
    let mut upper = slot_count;
    while lower < upper {
        let length = lower + (upper - lower).div_ceil(2);
        let first_range = slot_mask(length);
        let found = (0..=slot_count - length).any(|start| {
            let range = first_range << start;
            votes
                .iter()
                .filter(|vote| supports(vote.unwrap_or_default(), range))
                .nth(quorum - 1)
                .is_some()
        });
        if found {
            lower = length;
        } else {
            upper = length - 1;
        }
    }
    lower
}

/// Evaluate a frozen roster in oracle order, with one entry per distinct member.
/// The caller authenticates membership and represents unsubmitted votes as None.
pub fn assess_window(
    slot_count: u8,
    min_down_slots: u8,
    down_quorum: usize,
    votes: &[Option<VoteMasks>],
) -> Result<Assessment, InvalidWindow> {
    if !(2..=64).contains(&slot_count) {
        return Err(InvalidWindow::SlotCount);
    }
    if !(2..=slot_count).contains(&min_down_slots) {
        return Err(InvalidWindow::DownThreshold);
    }
    if votes.len() < 3 || !(votes.len() / 2 + 1..=votes.len()).contains(&down_quorum) {
        return Err(InvalidWindow::Quorum);
    }
    let valid = slot_mask(slot_count);
    if votes
        .iter()
        .flatten()
        .any(|vote| vote.up & vote.down != 0 || (vote.up | vote.down) & !valid != 0)
    {
        return Err(InvalidWindow::VoteMasks);
    }

    let confirmed = longest_supported_run(votes, slot_count, down_quorum, |vote, range| {
        vote.down & range == range
    });
    let possible = longest_supported_run(votes, slot_count, down_quorum, |vote, range| {
        vote.up & range == 0
    });
    let outcome = if confirmed >= min_down_slots {
        Outcome::Breach
    } else if possible < min_down_slots {
        Outcome::Healthy
    } else {
        Outcome::Inconclusive
    };
    Ok(Assessment {
        outcome,
        confirmed,
        possible,
    })
}
