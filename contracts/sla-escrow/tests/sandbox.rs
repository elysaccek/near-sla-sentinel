use std::{error::Error, path::PathBuf, time::Duration};

use near_workspaces::{Contract, Worker, network::Sandbox, types::NearToken};
use serde_json::{Value, json};

type TestResult<T> = Result<T, Box<dyn Error>>;

const SLOT_MS: u32 = 3_000;
const SLOT_COUNT: u8 = 5;
const REPORTING_GRACE_MS: u32 = 120_000;
const PAYOUT: NearToken = NearToken::from_millinear(100);

fn wasm_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SLA_ESCROW_WASM") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/near/sla_escrow.wasm")
}

async fn chain_time_ms(worker: &Worker<Sandbox>) -> TestResult<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

async fn advance_to(worker: &Worker<Sandbox>, target_ms: u64) -> TestResult<()> {
    let wait_until = tokio::time::Instant::now() + Duration::from_secs(90);
    while chain_time_ms(worker).await? < target_ms {
        if tokio::time::Instant::now() >= wait_until {
            return Err("sandbox chain time did not reach the end of the sampling period".into());
        }
        worker.fast_forward(10).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

async fn agreement(contract: &Contract, args: &Value) -> TestResult<Value> {
    Ok(contract.view("get_sla").args_json(args).await?.json()?)
}

#[tokio::test]
async fn corroborated_outage_settles_one_native_near_transfer() -> TestResult<()> {
    let path = wasm_path();
    let wasm = std::fs::read(&path).map_err(|error| {
        format!(
            "could not read {}: {error}. Build the contract first or set SLA_ESCROW_WASM.",
            path.display()
        )
    })?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let provider = worker.dev_create_account().await?;
    let customer = worker.dev_create_account().await?;
    let oracle_a = worker.dev_create_account().await?;
    let oracle_b = worker.dev_create_account().await?;
    let oracle_c = worker.dev_create_account().await?;

    let storage_deposit: String = contract
        .view("storage_deposit")
        .args_json(json!({}))
        .await?
        .json()?;
    let storage_deposit: u128 = storage_deposit.parse()?;
    let attached = NearToken::from_yoctonear(PAYOUT.as_yoctonear() + storage_deposit);
    let starts_at_ms = chain_time_ms(&worker).await? + 25_000;
    let ends_at_ms = starts_at_ms + u64::from(SLOT_MS) * u64::from(SLOT_COUNT);

    let mut offer = json!({
        "customer": customer.id(),
        "oracles": [oracle_a.id(), oracle_b.id(), oracle_c.id()],
        "endpoint_hash": vec![17; 32],
        "starts_at_ms": starts_at_ms.to_string(),
        "slot_ms": SLOT_MS,
        "slot_count": SLOT_COUNT,
        "min_down_slots": 3,
        "reporting_grace_ms": REPORTING_GRACE_MS,
        "payout": PAYOUT.as_yoctonear().to_string()
    });
    let sla_id: String = provider
        .call(contract.id(), "create_sla")
        .args_json(&offer)
        .deposit(attached)
        .max_gas()
        .transact()
        .await?
        .json()?;
    let id_args = json!({ "sla_id": sla_id });

    customer
        .call(contract.id(), "accept_sla")
        .args_json(&id_args)
        .transact()
        .await?
        .into_result()?;

    advance_to(&worker, ends_at_ms).await?;
    assert!(chain_time_ms(&worker).await? < ends_at_ms + u64::from(REPORTING_GRACE_MS));

    let vote_a = json!({
        "sla_id": sla_id, "up_mask": "17", "down_mask": "14", "evidence_hash": vec![1; 32]
    });
    let vote_b = json!({
        "sla_id": sla_id, "up_mask": "17", "down_mask": "14", "evidence_hash": vec![2; 32]
    });
    let vote_c = json!({
        "sla_id": sla_id, "up_mask": "31", "down_mask": "0", "evidence_hash": vec![3; 32]
    });

    let unauthorized = provider
        .call(contract.id(), "submit_vote")
        .args_json(&vote_a)
        .transact()
        .await?;
    assert!(unauthorized.is_failure(), "{unauthorized:?}");

    oracle_a
        .call(contract.id(), "submit_vote")
        .args_json(&vote_a)
        .transact()
        .await?
        .into_result()?;

    let premature_claim = customer
        .call(contract.id(), "claim")
        .args_json(&id_args)
        .max_gas()
        .transact()
        .await?;
    assert!(premature_claim.is_failure(), "{premature_claim:?}");

    let duplicate_vote = oracle_a
        .call(contract.id(), "submit_vote")
        .args_json(&vote_b)
        .transact()
        .await?;
    assert!(duplicate_vote.is_failure(), "{duplicate_vote:?}");

    oracle_b
        .call(contract.id(), "submit_vote")
        .args_json(&vote_b)
        .transact()
        .await?
        .into_result()?;
    oracle_c
        .call(contract.id(), "submit_vote")
        .args_json(&vote_c)
        .transact()
        .await?
        .into_result()?;

    provider
        .call(contract.id(), "finalize")
        .args_json(&id_args)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(agreement(&contract, &id_args).await?["outcome"], "breach");

    let wrong_beneficiary = provider
        .call(contract.id(), "claim")
        .args_json(&id_args)
        .max_gas()
        .transact()
        .await?;
    assert!(wrong_beneficiary.is_failure(), "{wrong_beneficiary:?}");

    let spoofed_callback = customer
        .call(contract.id(), "on_payment")
        .args_json(json!({ "sla_id": sla_id, "attempt": 1 }))
        .transact()
        .await?;
    assert!(spoofed_callback.is_failure(), "{spoofed_callback:?}");
    assert_eq!(
        agreement(&contract, &id_args).await?["payment"],
        "claimable"
    );

    let balance_before = customer.view_account().await?.balance.as_yoctonear();
    let payout = customer
        .call(contract.id(), "claim")
        .args_json(&id_args)
        .max_gas()
        .transact()
        .await?;
    assert!(payout.is_success(), "{payout:?}");
    assert!(payout.receipt_failures().is_empty(), "{payout:?}");
    assert!(
        payout
            .receipt_outcomes()
            .iter()
            .any(|receipt| { &receipt.executor_id == customer.id() && receipt.is_success() }),
        "missing a successful receipt executed on the beneficiary: {payout:?}"
    );
    assert_eq!(agreement(&contract, &id_args).await?["payment"], "paid");
    let balance_after = customer.view_account().await?.balance.as_yoctonear();
    let net_received = balance_after
        .checked_sub(balance_before)
        .unwrap_or_default();
    assert!(net_received > 0 && net_received <= PAYOUT.as_yoctonear());

    let duplicate_claim = customer
        .call(contract.id(), "claim")
        .args_json(&id_args)
        .max_gas()
        .transact()
        .await?;
    assert!(duplicate_claim.is_failure(), "{duplicate_claim:?}");
    assert_eq!(agreement(&contract, &id_args).await?["payment"], "paid");
    assert!(customer.view_account().await?.balance.as_yoctonear() <= balance_after);

    let refund_start_ms = chain_time_ms(&worker).await? + 15_000;
    offer["starts_at_ms"] = json!(refund_start_ms.to_string());
    let refund_id: String = provider
        .call(contract.id(), "create_sla")
        .args_json(&offer)
        .deposit(attached)
        .max_gas()
        .transact()
        .await?
        .json()?;
    let refund_args = json!({ "sla_id": refund_id });
    advance_to(&worker, refund_start_ms).await?;
    provider
        .call(contract.id(), "finalize")
        .args_json(&refund_args)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        agreement(&contract, &refund_args).await?["outcome"],
        "unaccepted"
    );
    let refund = provider
        .call(contract.id(), "claim")
        .args_json(&refund_args)
        .max_gas()
        .transact()
        .await?;
    assert!(refund.is_success(), "{refund:?}");
    assert!(refund.receipt_failures().is_empty(), "{refund:?}");
    assert_eq!(agreement(&contract, &refund_args).await?["payment"], "paid");
    Ok(())
}
