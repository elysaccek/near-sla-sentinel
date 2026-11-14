use crate::{Payment, SlaEscrowV2, SlaEscrowV2Ext, emit};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, Gas, NearToken, Promise, env, near, require};

#[near]
impl SlaEscrowV2 {
    #[private]
    pub fn schedule_missing_recipient(&self, escrow_id: AccountId, sla_id: U64) -> Promise {
        Promise::new(escrow_id).function_call(
            "claim",
            json!({ "sla_id": sla_id }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(60),
        )
    }

    #[private]
    pub fn schedule_unresolved_payment(&mut self, sla_id: U64) -> Promise {
        let settlement = self.settlement_mut(sla_id);
        require!(
            settlement.payment == Payment::Claimable && settlement.attempt == 0,
            "Expected an unclaimed fixture agreement"
        );
        let recipient = settlement.beneficiary().clone();
        let amount = settlement.payout;
        let attempt = 1;
        settlement.attempt = attempt;
        settlement.payment = Payment::Pending;
        emit(
            "payment_pending",
            sla_id,
            json!({"attempt": attempt, "recipient": recipient, "amount": amount}),
        );
        // Keep the transfer real and starve only the dependent Sandbox callback.
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_gas(1))
                    .with_unused_gas_weight(0)
                    .on_payment(sla_id, attempt),
            )
    }
}
