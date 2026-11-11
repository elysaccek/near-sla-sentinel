mod policy;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseError, env, near, require};

const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
const CONTRACT_STATE_ALLOWANCE_BYTES: u64 = 256;
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const CLAIM_GAS_MINIMUM: Gas = Gas::from_tgas(60);
const DAY_MS: u64 = 86_400_000;
const POLICY_VERSION: u8 = 1;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Default)]
pub struct Vote {
    pub submitted: bool,
    pub up_mask: U64,
    pub down_mask: U64,
    pub evidence_hash: [u8; 32],
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

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Payment {
    Unavailable,
    Claimable,
    Pending,
    Paid,
}

#[near(serializers = [borsh, json])]
pub struct Agreement {
    pub provider: AccountId,
    pub customer: AccountId,
    pub oracles: [AccountId; 3],
    pub endpoint_hash: [u8; 32],
    pub policy_version: u8,
    pub starts_at_ms: U64,
    pub ends_at_ms: U64,
    pub reporting_deadline_ms: U64,
    pub slot_ms: u32,
    pub slot_count: u8,
    pub min_down_slots: u8,
    pub payout: U128,
    pub accepted: bool,
    pub votes: [Vote; 3],
    pub outcome: Outcome,
    pub confirmed_down_slots: u8,
    pub possible_down_slots: u8,
    pub payment: Payment,
    pub attempt: u32,
}

impl Agreement {
    fn beneficiary(&self) -> &AccountId {
        if self.outcome == Outcome::Breach {
            &self.customer
        } else {
            &self.provider
        }
    }
}

#[near(contract_state)]
pub struct SlaEscrow {
    next_id: u64,
    agreements: LookupMap<u64, Agreement>,
}

impl Default for SlaEscrow {
    fn default() -> Self {
        Self {
            next_id: 0,
            agreements: LookupMap::new(b"a"),
        }
    }
}

#[near]
impl SlaEscrow {
    pub fn storage_deposit(&self) -> U128 {
        U128(STORAGE_DEPOSIT.as_yoctonear())
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_sla(
        &mut self,
        customer: AccountId,
        oracles: [AccountId; 3],
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
        require!(provider != customer, "Provider and customer must differ");
        require!(
            provider != contract && customer != contract,
            "Invalid party"
        );
        let [a, b, c] = &oracles;
        require!(a != b && a != c && b != c, "Oracle accounts must differ");
        require!(
            oracles
                .iter()
                .all(|id| id != &provider && id != &customer && id != &contract),
            "Oracle accounts must differ from the parties and contract"
        );
        require!(endpoint_hash != [0; 32], "Missing endpoint hash");
        let now = env::block_timestamp_ms();
        require!(
            starts_at_ms.0 > now && starts_at_ms.0 <= now + 7 * DAY_MS,
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
            .checked_add(STORAGE_DEPOSIT.as_yoctonear())
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
        let agreement = Agreement {
            provider,
            customer,
            oracles,
            endpoint_hash,
            policy_version: POLICY_VERSION,
            starts_at_ms,
            ends_at_ms: U64(ends_at_ms),
            reporting_deadline_ms: U64(ends_at_ms + u64::from(reporting_grace_ms)),
            slot_ms,
            slot_count,
            min_down_slots,
            payout,
            accepted: false,
            votes: [Vote::default(); 3],
            outcome: Outcome::Undecided,
            confirmed_down_slots: 0,
            possible_down_slots: slot_count,
            payment: Payment::Unavailable,
            attempt: 0,
        };
        let before = env::storage_usage();
        self.agreements.insert(id, agreement);
        self.agreements.flush();
        let bytes = env::storage_usage().saturating_sub(before) + CONTRACT_STATE_ALLOWANCE_BYTES;
        let storage_cost = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        require!(
            storage_cost <= STORAGE_DEPOSIT.as_yoctonear(),
            "Storage deposit does not cover agreement"
        );
        emit(
            "agreement_funded",
            U64(id),
            json!({"payout": payout, "storage_deposit": self.storage_deposit()}),
        );
        U64(id)
    }

    pub fn accept_sla(&mut self, sla_id: U64) {
        let agreement = self.agreement_mut(sla_id);
        require!(
            env::predecessor_account_id() == agreement.customer,
            "Only customer can accept"
        );
        require!(
            !agreement.accepted && env::block_timestamp_ms() < agreement.starts_at_ms.0,
            "Offer cannot be accepted"
        );
        agreement.accepted = true;
        emit("agreement_accepted", sla_id, json!({}));
    }

    pub fn submit_vote(
        &mut self,
        sla_id: U64,
        up_mask: U64,
        down_mask: U64,
        evidence_hash: [u8; 32],
    ) {
        let agreement = self.agreement_mut(sla_id);
        let oracle = env::predecessor_account_id();
        let index = agreement
            .oracles
            .iter()
            .position(|id| id == &oracle)
            .unwrap_or_else(|| env::panic_str("Unauthorized oracle"));
        require!(
            agreement.accepted && agreement.outcome == Outcome::Undecided,
            "Agreement cannot accept votes"
        );
        let now = env::block_timestamp_ms();
        require!(
            now >= agreement.ends_at_ms.0 && now < agreement.reporting_deadline_ms.0,
            "Outside reporting period"
        );
        require!(!agreement.votes[index].submitted, "Oracle already voted");
        require!(evidence_hash != [0; 32], "Missing evidence hash");
        let valid = policy::slot_mask(agreement.slot_count);
        require!(
            up_mask.0 & down_mask.0 == 0 && (up_mask.0 | down_mask.0) & !valid == 0,
            "Invalid slot masks"
        );
        agreement.votes[index] = Vote {
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
        let agreement = self.agreement_mut(sla_id);
        require!(
            agreement.outcome == Outcome::Undecided,
            "Agreement already finalized"
        );
        let now = env::block_timestamp_ms();
        if agreement.accepted {
            require!(
                now >= agreement.reporting_deadline_ms.0
                    || agreement.votes.iter().all(|vote| vote.submitted),
                "Reporting period still open"
            );
            let (confirmed, possible) = policy::down_streak_bounds(
                agreement.votes.map(|vote| vote.up_mask.0),
                agreement.votes.map(|vote| vote.down_mask.0),
                agreement.slot_count,
            );
            agreement.outcome = if confirmed >= agreement.min_down_slots {
                Outcome::Breach
            } else if possible < agreement.min_down_slots {
                Outcome::Healthy
            } else {
                Outcome::Inconclusive
            };
            agreement.confirmed_down_slots = confirmed;
            agreement.possible_down_slots = possible;
        } else {
            require!(now >= agreement.starts_at_ms.0, "Offer still open");
            agreement.outcome = Outcome::Unaccepted;
        }
        agreement.payment = Payment::Claimable;
        emit(
            "agreement_finalized",
            sla_id,
            json!({
                "outcome": agreement.outcome,
                "confirmed_down_slots": agreement.confirmed_down_slots,
                "possible_down_slots": agreement.possible_down_slots,
                "beneficiary": agreement.beneficiary(),
            }),
        );
        agreement.outcome
    }

    pub fn claim(&mut self, sla_id: U64) -> Promise {
        require!(
            env::prepaid_gas() >= CLAIM_GAS_MINIMUM,
            "Attach at least 60 Tgas"
        );
        let agreement = self.agreement_mut(sla_id);
        require!(
            agreement.payment == Payment::Claimable,
            "Payment not claimable"
        );
        let recipient = agreement.beneficiary().clone();
        require!(
            env::predecessor_account_id() == recipient,
            "Only beneficiary can claim"
        );
        agreement.attempt = agreement
            .attempt
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Payment attempts exhausted"));
        agreement.payment = Payment::Pending;
        let attempt = agreement.attempt;
        emit(
            "payment_pending",
            sla_id,
            json!({"attempt": attempt, "recipient": recipient, "amount": agreement.payout}),
        );
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(agreement.payout.0))
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
        let Some(agreement) = self.agreements.get_mut(&sla_id.0) else {
            return false;
        };
        if agreement.payment != Payment::Pending || agreement.attempt != attempt {
            return false;
        }
        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                agreement.payment = Payment::Paid;
                emit("payment_succeeded", sla_id, json!({"attempt": attempt}));
                true
            }
            Err(PromiseError::Failed) => {
                agreement.payment = Payment::Claimable;
                emit("payment_failed", sla_id, json!({"attempt": attempt}));
                false
            }
            // An unexpected successful result must never allow a second transfer.
            Err(_) => false,
        }
    }

    pub fn get_sla(&self, sla_id: U64) -> Option<&Agreement> {
        self.agreements.get(&sla_id.0)
    }

    pub fn agreement_count(&self) -> U64 {
        U64(self.next_id)
    }
}

impl SlaEscrow {
    fn agreement_mut(&mut self, sla_id: U64) -> &mut Agreement {
        self.agreements
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
