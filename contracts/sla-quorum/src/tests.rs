use super::{Assessment, InvalidWindow, Outcome, VoteMasks, assess_window};

#[test]
fn matches_shared_window_vectors() {
    let fixtures = include_str!("../../../fixtures/quorum-windows.tsv");
    for line in fixtures.lines().filter(|line| !line.starts_with('#')) {
        let fields: Vec<_> = line.split_whitespace().collect();
        let [
            name,
            slots,
            threshold,
            quorum,
            entries,
            outcome,
            confirmed,
            possible,
        ] = fields[..]
        else {
            panic!("Malformed fixture: {line}");
        };
        let votes: Vec<_> = entries
            .split(',')
            .map(|entry| {
                if entry == "-" {
                    return None;
                }
                let (up, down) = entry.split_once(':').unwrap();
                Some(VoteMasks {
                    up: up.parse().unwrap(),
                    down: down.parse().unwrap(),
                })
            })
            .collect();
        let expected = Assessment {
            outcome: match outcome {
                "breach" => Outcome::Breach,
                "healthy" => Outcome::Healthy,
                "inconclusive" => Outcome::Inconclusive,
                _ => panic!("Unknown outcome: {outcome}"),
            },
            confirmed: confirmed.parse().unwrap(),
            possible: possible.parse().unwrap(),
        };
        assert_eq!(
            assess_window(
                slots.parse().unwrap(),
                threshold.parse().unwrap(),
                quorum.parse().unwrap(),
                &votes
            ),
            Ok(expected),
            "{name}"
        );
    }
}

#[test]
fn rejects_invalid_windows_quorums_and_masks() {
    let empty = [None; 5];
    assert_eq!(
        assess_window(65, 2, 3, &empty),
        Err(InvalidWindow::SlotCount)
    );
    assert_eq!(
        assess_window(4, 5, 3, &empty),
        Err(InvalidWindow::DownThreshold)
    );
    assert_eq!(assess_window(4, 2, 2, &empty), Err(InvalidWindow::Quorum));
    assert_eq!(assess_window(4, 2, 6, &empty), Err(InvalidWindow::Quorum));
    assert_eq!(
        assess_window(4, 2, 2, &empty[..2]),
        Err(InvalidWindow::Quorum)
    );
    for invalid in [VoteMasks { up: 1, down: 1 }, VoteMasks { up: 0, down: 16 }] {
        assert_eq!(
            assess_window(4, 2, 2, &[Some(invalid), None, None]),
            Err(InvalidWindow::VoteMasks)
        );
    }
}
