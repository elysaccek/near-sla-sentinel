#[cfg(feature = "sandbox-fixture")]
mod sandbox_fixture;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require,
};
use sla_quorum::{Outcome as QuorumOutcome, VoteMasks, assess_window};
use std::collections::BTreeSet;

const POLICY_VERSION: u8 = 2;
const MIN_ORACLES: u8 = 3;
const MAX_ORACLES: u8 = 16;
const DAY_MS: u64 = 86_400_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const CLAIM_GAS_MINIMUM: Gas = Gas::from_tgas(60);
// Covers the fixed records, including two maximum-length party IDs and trie overhead.
const FIXED_STORAGE_BUDGET_BYTES: u64 = 512;
// A maximum-length account ID uses 68 Borsh bytes and a reserved vote uses 49.
const STORAGE_BUDGET_BYTES_PER_ORACLE: u64 = 120;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Default)]
struct Vote {
    submitted: bool,
    up_mask: U64,
    down_mask: U64,
    evidence_hash: [u8; 32],
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Outcome {
    Undecided,
    Breach,
    Healthy,
    Inconclusive,
    Unaccepted,
}

impl From<QuorumOutcome> for Outcome {
    fn from(outcome: QuorumOutcome) -> Self {
        match outcome {
            QuorumOutcome::Breach => Self::Breach,
            QuorumOutcome::Healthy => Self::Healthy,
            QuorumOutcome::Inconclusive => Self::Inconclusive,
        }
    }
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Eq, PartialEq)]
enum Payment {
    Unavailable,
    Claimable,
    Pending,
    Paid,
}

#[near(serializers = [borsh, json])]
struct Terms {
    oracles: Vec<AccountId>,
    down_quorum: u8,
    endpoint_hash: [u8; 32],
    policy_version: u8,
    starts_at_ms: U64,
    ends_at_ms: U64,
    reporting_deadline_ms: U64,
    slot_ms: u32,
    slot_count: u8,
    min_down_slots: u8,
    accepted: bool,
    votes: Vec<Vote>,
}

#[near(serializers = [borsh, json])]
struct Settlement {
    provider: AccountId,
    customer: AccountId,
    payout: U128,
    outcome: Outcome,
    confirmed_down_slots: u8,
    possible_down_slots: u8,
    payment: Payment,
    attempt: u32,
}

impl Settlement {
    fn beneficiary(&self) -> &AccountId {
        if self.outcome == Outcome::Breach {
            &self.customer
        } else {
            &self.provider
        }
    }
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AgreementView<'a> {
    #[serde(flatten)]
    terms: &'a Terms,
    #[serde(flatten)]
    settlement: &'a Settlement,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SlaEscrowV2 {
    next_id: u64,
    terms: LookupMap<u64, Terms>,
    settlements: LookupMap<u64, Settlement>,
}

#[near]
impl SlaEscrowV2 {
    #[init]
    pub fn new() -> Self {
        Self {
            next_id: 0,
            terms: LookupMap::new(b"t"),
            settlements: LookupMap::new(b"s"),
        }
    }

    pub fn storage_deposit(&self, oracle_count: u8) -> U128 {
        require!(
            (MIN_ORACLES..=MAX_ORACLES).contains(&oracle_count),
            "Invalid oracle count"
        );
        let bytes =
            FIXED_STORAGE_BUDGET_BYTES + STORAGE_BUDGET_BYTES_PER_ORACLE * u64::from(oracle_count);
        U128(u128::from(bytes) * env::storage_byte_cost().as_yoctonear())
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_sla(
        &mut self,
        customer: AccountId,
        oracles: Vec<AccountId>,
        down_quorum: Option<u8>,
        endpoint_hash: [u8; 32],
        starts_at_ms: U64,
        slot_ms: u32,
        slot_count: u8,
        min_down_slots: u8,
        reporting_grace_ms: u32,
        payout: U128,
    ) -> U64 {
        let provider = env::predecessor_account_id();
        let contract = env::current_account_id();
        require!(
            provider != customer && provider != contract && customer != contract,
            "Invalid parties"
        );
        let oracle_count =
            u8::try_from(oracles.len()).unwrap_or_else(|_| env::panic_str("Invalid oracle count"));
        let storage_deposit = self.storage_deposit(oracle_count);
        let majority = oracle_count / 2 + 1;
        let down_quorum = down_quorum.unwrap_or(majority);
        require!(
            (majority..=oracle_count).contains(&down_quorum),
            "Invalid down quorum"
        );
        require!(
            oracles.iter().collect::<BTreeSet<_>>().len() == oracles.len(),
            "Oracle accounts must differ"
        );
        require!(
            oracles
                .iter()
                .all(|id| id != &provider && id != &customer && id != &contract),
            "Oracle accounts must differ from the parties and contract"
        );
        require!(endpoint_hash != [0; 32], "Missing endpoint hash");
        let now = env::block_timestamp_ms();
        require!(
            starts_at_ms.0 > now && starts_at_ms.0 - now <= 7 * DAY_MS,
            "Start must be in the next seven days"
        );
        require!(
            (1_000..=3_600_000).contains(&slot_ms),
            "Invalid slot length"
        );
        require!((2..=64).contains(&slot_count), "Invalid slot count");
        require!(
            (2..=slot_count).contains(&min_down_slots),
            "Invalid outage threshold"
        );
        require!(
            (1_000..=DAY_MS).contains(&u64::from(reporting_grace_ms)),
            "Invalid reporting grace"
        );
        require!(payout.0 > 0, "Payout must be positive");
        let required_deposit = payout
            .0
            .checked_add(storage_deposit.0)
            .unwrap_or_else(|| env::panic_str("Deposit overflow"));
        require!(
            env::attached_deposit().as_yoctonear() == required_deposit,
            "Attach exactly payout plus storage deposit"
        );

        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Agreement IDs exhausted"));
        let ends_at_ms = starts_at_ms.0 + u64::from(slot_ms) * u64::from(slot_count);
        let before = env::storage_usage();
        self.terms.insert(
            id,
            Terms {
                oracles,
                down_quorum,
                endpoint_hash,
                policy_version: POLICY_VERSION,
                starts_at_ms,
                ends_at_ms: U64(ends_at_ms),
                reporting_deadline_ms: U64(ends_at_ms + u64::from(reporting_grace_ms)),
                slot_ms,
                slot_count,
                min_down_slots,
                accepted: false,
                votes: vec![Vote::default(); usize::from(oracle_count)],
            },
        );
        self.settlements.insert(
            id,
            Settlement {
                provider,
                customer,
                payout,
                outcome: Outcome::Undecided,
                confirmed_down_slots: 0,
                possible_down_slots: slot_count,
                payment: Payment::Unavailable,
                attempt: 0,
            },
        );
        self.terms.flush();
        self.settlements.flush();
        let storage_bytes = env::storage_usage() - before;
        require!(
            u128::from(storage_bytes) * env::storage_byte_cost().as_yoctonear()
                <= storage_deposit.0,
            "Storage deposit does not cover agreement"
        );
        emit(
            "agreement_funded",
            U64(id),
            json!({
                "policy_version": POLICY_VERSION, "oracle_count": oracle_count, "down_quorum": down_quorum,
                "payout": payout, "storage_deposit": storage_deposit, "storage_bytes": storage_bytes,
            }),
        );
        U64(id)
    }

    pub fn accept_sla(&mut self, sla_id: U64) {
        let settlement = self
            .settlements
            .get(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"));
        require!(
            env::predecessor_account_id() == settlement.customer,
            "Only customer can accept"
        );
        let terms = self
            .terms
            .get_mut(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"));
        require!(
            !terms.accepted && env::block_timestamp_ms() < terms.starts_at_ms.0,
            "Offer cannot be accepted"
        );
        terms.accepted = true;
        emit("agreement_accepted", sla_id, json!({}));
    }

    pub fn submit_vote(
        &mut self,
        sla_id: U64,
        up_mask: U64,
        down_mask: U64,
        evidence_hash: [u8; 32],
    ) {
        let terms = self
            .terms
            .get_mut(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"));
        let oracle = env::predecessor_account_id();
        let index = terms
            .oracles
            .iter()
            .position(|id| id == &oracle)
            .unwrap_or_else(|| env::panic_str("Unauthorized oracle"));
        let settlement = self
            .settlements
            .get(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"));
        require!(
            terms.accepted && settlement.outcome == Outcome::Undecided,
            "Agreement cannot accept votes"
        );
        let now = env::block_timestamp_ms();
        require!(
            now >= terms.ends_at_ms.0 && now < terms.reporting_deadline_ms.0,
            "Outside reporting period"
        );
        require!(!terms.votes[index].submitted, "Oracle already voted");
        require!(evidence_hash != [0; 32], "Missing evidence hash");
        let valid = u64::MAX >> (64 - terms.slot_count);
        require!(
            up_mask.0 & down_mask.0 == 0 && (up_mask.0 | down_mask.0) & !valid == 0,
            "Invalid slot masks"
        );
        terms.votes[index] = Vote {
            submitted: true,
            up_mask,
            down_mask,
            evidence_hash,
        };
        emit(
            "vote_recorded",
            sla_id,
            json!({"oracle": oracle, "evidence_hash": evidence_hash}),
        );
    }

    pub fn finalize(&mut self, sla_id: U64) -> Outcome {
        let terms = self
            .terms
            .get(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"));
        let settlement = self
            .settlements
            .get_mut(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"));
        require!(
            settlement.outcome == Outcome::Undecided,
            "Agreement already finalized"
        );
        let now = env::block_timestamp_ms();
        if terms.accepted {
            require!(
                now >= terms.reporting_deadline_ms.0
                    || terms.votes.iter().all(|vote| vote.submitted),
                "Reporting period still open"
            );
            let masks: Vec<_> = terms
                .votes
                .iter()
                .map(|vote| {
                    vote.submitted.then_some(VoteMasks {
                        up: vote.up_mask.0,
                        down: vote.down_mask.0,
                    })
                })
                .collect();
            let result = assess_window(
                terms.slot_count,
                terms.min_down_slots,
                usize::from(terms.down_quorum),
                &masks,
            )
            .unwrap_or_else(|_| env::panic_str("Invalid stored observation window"));
            settlement.outcome = result.outcome.into();
            settlement.confirmed_down_slots = result.confirmed;
            settlement.possible_down_slots = result.possible;
        } else {
            require!(now >= terms.starts_at_ms.0, "Offer still open");
            settlement.outcome = Outcome::Unaccepted;
        }
        settlement.payment = Payment::Claimable;
        emit(
            "agreement_finalized",
            sla_id,
            json!({
                "outcome": settlement.outcome,
                "confirmed_down_slots": settlement.confirmed_down_slots,
                "possible_down_slots": settlement.possible_down_slots,
                "beneficiary": settlement.beneficiary(),
            }),
        );
        settlement.outcome
    }

    pub fn claim(&mut self, sla_id: U64) -> Promise {
        require!(
            env::prepaid_gas() >= CLAIM_GAS_MINIMUM,
            "Attach at least 60 Tgas"
        );
        let settlement = self.settlement_mut(sla_id);
        require!(
            settlement.payment == Payment::Claimable,
            "Payment not claimable"
        );
        let recipient = settlement.beneficiary().clone();
        require!(
            env::predecessor_account_id() == recipient,
            "Only beneficiary can claim"
        );
        settlement.attempt = settlement
            .attempt
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Payment attempts exhausted"));
        settlement.payment = Payment::Pending;
        let attempt = settlement.attempt;
        emit(
            "payment_pending",
            sla_id,
            json!({"attempt": attempt, "recipient": recipient, "amount": settlement.payout}),
        );
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(settlement.payout.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payment(sla_id, attempt),
            )
    }

    #[private]
    pub fn on_payment(&mut self, sla_id: U64, attempt: u32) -> bool {
        if env::promise_results_count() != 1 {
            return false;
        }
        let Some(settlement) = self.settlements.get_mut(&sla_id.0) else {
            return false;
        };
        if settlement.payment != Payment::Pending || settlement.attempt != attempt {
            return false;
        }
        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                settlement.payment = Payment::Paid;
                emit("payment_succeeded", sla_id, json!({"attempt": attempt}));
                true
            }
            Err(PromiseError::Failed) => {
                settlement.payment = Payment::Claimable;
                emit("payment_failed", sla_id, json!({"attempt": attempt}));
                false
            }
            // An unexpected successful result must never make a second transfer possible.
            Err(_) => false,
        }
    }

    pub fn get_sla(&self, sla_id: U64) -> Option<AgreementView<'_>> {
        Some(AgreementView {
            terms: self.terms.get(&sla_id.0)?,
            settlement: self.settlements.get(&sla_id.0)?,
        })
    }

    pub fn agreement_count(&self) -> U64 {
        U64(self.next_id)
    }
}

impl SlaEscrowV2 {
    fn settlement_mut(&mut self, sla_id: U64) -> &mut Settlement {
        self.settlements
            .get_mut(&sla_id.0)
            .unwrap_or_else(|| env::panic_str("Agreement not found"))
    }
}

fn emit(event: &str, sla_id: U64, mut data: Value) {
    data["sla_id"] = json!(sla_id);
    let envelope =
        json!({"standard": "sla_sentinel", "version": "1.0.0", "event": event, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{envelope}"));
}
