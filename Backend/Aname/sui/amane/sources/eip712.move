#[allow(implicit_const_copy)]
/// EIP-712 structs and hashing. Type strings must stay byte-identical with
/// packages/core/src/eip712.ts and evm/src/AmaneTypes.sol; golden vectors enforce this.
module amane::eip712;

use amane::crypto;
use sui::bcs;
use sui::hash::keccak256;

const EBadLength: u64 = 200;

const SIGNING_CHAIN_ID: u256 = 11155111;

const ADAPTER_REF_T: vector<u8> = b"AdapterRef(bytes32 adapterId,string adapterName,uint32 adapterVersion)";
const ASSET_LIMIT_T: vector<u8> = b"AssetLimit(bytes32 assetId,uint256 maxPerAction,uint256 maxPerEpoch,uint256 maxTotal)";
const ISSUER_LIMIT_T: vector<u8> =
    b"IssuerLimit(bytes32 chainRef,bytes32 assetId,uint256 maxPerAction,uint256 maxPerEpoch,uint256 maxTotal)";
const LEASE_ISSUER_T: vector<u8> =
    b"LeaseIssuer(address issuer,uint64 maxLeaseLifetime,address[] allowedAgents,IssuerLimit[] limits)";
const POLICY_ENDPOINT_T: vector<u8> =
    b"PolicyEndpoint(bytes32 chainRef,bytes32 account,uint64 epochSeconds,AdapterRef[] adapters,AssetLimit[] assets,Recipient[] recipients,Recipient[] beneficiaries,SwapFloor[] swapFloors,Recipient[] recoveryDestinations)";
const RECIPIENT_T: vector<u8> = b"Recipient(bytes32 recipientId,string label)";
const SWAP_FLOOR_T: vector<u8> =
    b"SwapFloor(bytes32 assetIn,bytes32 assetOut,uint256 minOutNumerator,uint256 minOutDenominator)";
const LEASE_ENDPOINT_T: vector<u8> =
    b"LeaseEndpoint(bytes32 chainRef,bytes32 account,bytes32[] adapters,AssetLimit[] assets,bytes32[] recipients,bytes32[] beneficiaries)";
const ROOT_POLICY_T: vector<u8> =
    b"RootPolicy(bytes32 accountId,uint64 policyVersion,bytes32 parentPolicyHash,uint32 allowedActions,uint8 priceMode,uint64 maxLeaseLifetime,uint64 activateBefore,PolicyEndpoint[] endpoints,LeaseIssuer[] leaseIssuers)";
const AGENT_LEASE_T: vector<u8> =
    b"AgentLease(bytes32 accountId,uint64 policyVersion,bytes32 leaseId,address agent,address issuer,uint64 validAfter,uint64 expiresAt,uint64 activateBefore,uint32 allowedActions,uint8 authMode,LeaseEndpoint[] endpoints)";
const ACTION_INTENT_T: vector<u8> =
    b"ActionIntent(bytes32 accountId,bytes32 chainRef,bytes32 account,uint64 policyVersion,bytes32 leaseId,uint64 nonce,uint8 actionKind,bytes32 adapterId,string adapterName,uint32 adapterVersion,bytes32 assetIn,bytes32 assetOut,uint256 amountIn,uint256 minAmountOut,bytes32 recipient,string recipientLabel,uint64 deadline,bytes32 planHash,uint32 planStep)";
const PAUSE_ACCOUNT_T: vector<u8> = b"PauseAccount(bytes32 accountId,uint64 pauseEpoch,bytes32 pauseId,uint64 deadline)";
const UNPAUSE_ACCOUNT_T: vector<u8> =
    b"UnpauseAccount(bytes32 accountId,bytes32 chainRef,bytes32 account,uint64 pauseEpoch,bytes32 pauseId,uint64 deadline)";
const REVOKE_LEASE_T: vector<u8> = b"RevokeLease(bytes32 accountId,bytes32 leaseId)";
const WITHDRAW_T: vector<u8> =
    b"Withdraw(bytes32 accountId,bytes32 chainRef,bytes32 account,bytes32 assetId,uint256 amount,bytes32 destination,uint64 opNonce,uint64 deadline)";

public struct AssetLimit has copy, drop, store {
    asset_id: vector<u8>,
    max_per_action: u256,
    max_per_epoch: u256,
    max_total: u256,
}

public struct AdapterRef has copy, drop, store {
    adapter_id: vector<u8>,
    adapter_name: vector<u8>,
    adapter_version: u32,
}

public struct Recipient has copy, drop, store {
    recipient_id: vector<u8>,
    label: vector<u8>,
}

public struct SwapFloor has copy, drop, store {
    asset_in: vector<u8>,
    asset_out: vector<u8>,
    min_out_numerator: u256,
    min_out_denominator: u256,
}

public struct PolicyEndpoint has copy, drop, store {
    chain_ref: vector<u8>,
    account: vector<u8>,
    epoch_seconds: u64,
    adapters: vector<AdapterRef>,
    assets: vector<AssetLimit>,
    recipients: vector<Recipient>,
    beneficiaries: vector<Recipient>,
    swap_floors: vector<SwapFloor>,
    recovery_destinations: vector<Recipient>,
}

public struct IssuerLimit has copy, drop, store {
    chain_ref: vector<u8>,
    asset_id: vector<u8>,
    max_per_action: u256,
    max_per_epoch: u256,
    max_total: u256,
}

public struct LeaseIssuer has copy, drop, store {
    issuer: vector<u8>,
    max_lease_lifetime: u64,
    allowed_agents: vector<vector<u8>>,
    limits: vector<IssuerLimit>,
}

public struct RootPolicy has copy, drop, store {
    account_id: vector<u8>,
    policy_version: u64,
    parent_policy_hash: vector<u8>,
    allowed_actions: u32,
    price_mode: u8,
    max_lease_lifetime: u64,
    activate_before: u64,
    endpoints: vector<PolicyEndpoint>,
    lease_issuers: vector<LeaseIssuer>,
}

public struct LeaseEndpoint has copy, drop, store {
    chain_ref: vector<u8>,
    account: vector<u8>,
    adapters: vector<vector<u8>>,
    assets: vector<AssetLimit>,
    recipients: vector<vector<u8>>,
    beneficiaries: vector<vector<u8>>,
}

public struct AgentLease has copy, drop, store {
    account_id: vector<u8>,
    policy_version: u64,
    lease_id: vector<u8>,
    agent: vector<u8>,
    issuer: vector<u8>,
    valid_after: u64,
    expires_at: u64,
    activate_before: u64,
    allowed_actions: u32,
    auth_mode: u8,
    endpoints: vector<LeaseEndpoint>,
}

public struct ActionIntent has copy, drop, store {
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    account: vector<u8>,
    policy_version: u64,
    lease_id: vector<u8>,
    nonce: u64,
    action_kind: u8,
    adapter_id: vector<u8>,
    adapter_name: vector<u8>,
    adapter_version: u32,
    asset_in: vector<u8>,
    asset_out: vector<u8>,
    amount_in: u256,
    min_amount_out: u256,
    recipient: vector<u8>,
    recipient_label: vector<u8>,
    deadline: u64,
    plan_hash: vector<u8>,
    plan_step: u32,
}

public struct PauseAccount has copy, drop, store {
    account_id: vector<u8>,
    pause_epoch: u64,
    pause_id: vector<u8>,
    deadline: u64,
}

public struct UnpauseAccount has copy, drop, store {
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    account: vector<u8>,
    pause_epoch: u64,
    pause_id: vector<u8>,
    deadline: u64,
}

public struct RevokeLease has copy, drop, store {
    account_id: vector<u8>,
    lease_id: vector<u8>,
}

public struct Withdraw has copy, drop, store {
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    account: vector<u8>,
    asset_id: vector<u8>,
    amount: u256,
    destination: vector<u8>,
    op_nonce: u64,
    deadline: u64,
}

// ---------------------------------------------------------------- constructors

fun b32(x: &vector<u8>) { assert!(x.length() == 32, EBadLength); }

fun b20(x: &vector<u8>) { assert!(x.length() == 20, EBadLength); }

fun all_b32(xs: &vector<vector<u8>>) { xs.do_ref!(|x| b32(x)); }

public fun asset_limit(asset_id: vector<u8>, max_per_action: u256, max_per_epoch: u256, max_total: u256): AssetLimit {
    b32(&asset_id);
    AssetLimit { asset_id, max_per_action, max_per_epoch, max_total }
}

public fun adapter_ref(adapter_id: vector<u8>, adapter_name: vector<u8>, adapter_version: u32): AdapterRef {
    b32(&adapter_id);
    AdapterRef { adapter_id, adapter_name, adapter_version }
}

public fun recipient(recipient_id: vector<u8>, label: vector<u8>): Recipient {
    b32(&recipient_id);
    Recipient { recipient_id, label }
}

public fun swap_floor(asset_in: vector<u8>, asset_out: vector<u8>, min_out_numerator: u256, min_out_denominator: u256): SwapFloor {
    b32(&asset_in);
    b32(&asset_out);
    SwapFloor { asset_in, asset_out, min_out_numerator, min_out_denominator }
}

public fun policy_endpoint(
    chain_ref: vector<u8>,
    account: vector<u8>,
    epoch_seconds: u64,
    adapters: vector<AdapterRef>,
    assets: vector<AssetLimit>,
    recipients: vector<Recipient>,
    beneficiaries: vector<Recipient>,
    swap_floors: vector<SwapFloor>,
    recovery_destinations: vector<Recipient>,
): PolicyEndpoint {
    b32(&chain_ref);
    b32(&account);
    PolicyEndpoint { chain_ref, account, epoch_seconds, adapters, assets, recipients, beneficiaries, swap_floors, recovery_destinations }
}

public fun issuer_limit(chain_ref: vector<u8>, asset_id: vector<u8>, max_per_action: u256, max_per_epoch: u256, max_total: u256): IssuerLimit {
    b32(&chain_ref);
    b32(&asset_id);
    IssuerLimit { chain_ref, asset_id, max_per_action, max_per_epoch, max_total }
}

public fun lease_issuer(issuer: vector<u8>, max_lease_lifetime: u64, allowed_agents: vector<vector<u8>>, limits: vector<IssuerLimit>): LeaseIssuer {
    b20(&issuer);
    allowed_agents.do_ref!(|a| b20(a));
    LeaseIssuer { issuer, max_lease_lifetime, allowed_agents, limits }
}

public fun root_policy(
    account_id: vector<u8>,
    policy_version: u64,
    parent_policy_hash: vector<u8>,
    allowed_actions: u32,
    price_mode: u8,
    max_lease_lifetime: u64,
    activate_before: u64,
    endpoints: vector<PolicyEndpoint>,
    lease_issuers: vector<LeaseIssuer>,
): RootPolicy {
    b32(&account_id);
    b32(&parent_policy_hash);
    RootPolicy {
        account_id,
        policy_version,
        parent_policy_hash,
        allowed_actions,
        price_mode,
        max_lease_lifetime,
        activate_before,
        endpoints,
        lease_issuers,
    }
}

public fun lease_endpoint(
    chain_ref: vector<u8>,
    account: vector<u8>,
    adapters: vector<vector<u8>>,
    assets: vector<AssetLimit>,
    recipients: vector<vector<u8>>,
    beneficiaries: vector<vector<u8>>,
): LeaseEndpoint {
    b32(&chain_ref);
    b32(&account);
    all_b32(&adapters);
    all_b32(&recipients);
    all_b32(&beneficiaries);
    LeaseEndpoint { chain_ref, account, adapters, assets, recipients, beneficiaries }
}

public fun agent_lease(
    account_id: vector<u8>,
    policy_version: u64,
    lease_id: vector<u8>,
    agent: vector<u8>,
    issuer: vector<u8>,
    valid_after: u64,
    expires_at: u64,
    activate_before: u64,
    allowed_actions: u32,
    auth_mode: u8,
    endpoints: vector<LeaseEndpoint>,
): AgentLease {
    b32(&account_id);
    b32(&lease_id);
    b20(&agent);
    b20(&issuer);
    AgentLease {
        account_id,
        policy_version,
        lease_id,
        agent,
        issuer,
        valid_after,
        expires_at,
        activate_before,
        allowed_actions,
        auth_mode,
        endpoints,
    }
}

public fun action_intent(
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    account: vector<u8>,
    policy_version: u64,
    lease_id: vector<u8>,
    nonce: u64,
    action_kind: u8,
    adapter_id: vector<u8>,
    adapter_name: vector<u8>,
    adapter_version: u32,
    asset_in: vector<u8>,
    asset_out: vector<u8>,
    amount_in: u256,
    min_amount_out: u256,
    recipient: vector<u8>,
    recipient_label: vector<u8>,
    deadline: u64,
    plan_hash: vector<u8>,
    plan_step: u32,
): ActionIntent {
    b32(&account_id);
    b32(&chain_ref);
    b32(&account);
    b32(&lease_id);
    b32(&adapter_id);
    b32(&asset_in);
    b32(&asset_out);
    b32(&recipient);
    b32(&plan_hash);
    ActionIntent {
        account_id,
        chain_ref,
        account,
        policy_version,
        lease_id,
        nonce,
        action_kind,
        adapter_id,
        adapter_name,
        adapter_version,
        asset_in,
        asset_out,
        amount_in,
        min_amount_out,
        recipient,
        recipient_label,
        deadline,
        plan_hash,
        plan_step,
    }
}

public fun pause_account(account_id: vector<u8>, pause_epoch: u64, pause_id: vector<u8>, deadline: u64): PauseAccount {
    b32(&account_id);
    b32(&pause_id);
    PauseAccount { account_id, pause_epoch, pause_id, deadline }
}

public fun unpause_account(
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    account: vector<u8>,
    pause_epoch: u64,
    pause_id: vector<u8>,
    deadline: u64,
): UnpauseAccount {
    b32(&account_id);
    b32(&chain_ref);
    b32(&account);
    b32(&pause_id);
    UnpauseAccount { account_id, chain_ref, account, pause_epoch, pause_id, deadline }
}

public fun revoke_lease(account_id: vector<u8>, lease_id: vector<u8>): RevokeLease {
    b32(&account_id);
    b32(&lease_id);
    RevokeLease { account_id, lease_id }
}

public fun withdraw(
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    account: vector<u8>,
    asset_id: vector<u8>,
    amount: u256,
    destination: vector<u8>,
    op_nonce: u64,
    deadline: u64,
): Withdraw {
    b32(&account_id);
    b32(&chain_ref);
    b32(&account);
    b32(&asset_id);
    b32(&destination);
    Withdraw { account_id, chain_ref, account, asset_id, amount, destination, op_nonce, deadline }
}

// ---------------------------------------------------------------- getters

public fun asset_limit_fields(x: &AssetLimit): (vector<u8>, u256, u256, u256) {
    (x.asset_id, x.max_per_action, x.max_per_epoch, x.max_total)
}

public fun adapter_ref_fields(x: &AdapterRef): (vector<u8>, vector<u8>, u32) { (x.adapter_id, x.adapter_name, x.adapter_version) }

public fun recipient_fields(x: &Recipient): (vector<u8>, vector<u8>) { (x.recipient_id, x.label) }

public fun swap_floor_fields(x: &SwapFloor): (vector<u8>, vector<u8>, u256, u256) {
    (x.asset_in, x.asset_out, x.min_out_numerator, x.min_out_denominator)
}

public fun issuer_limit_fields(x: &IssuerLimit): (vector<u8>, vector<u8>, u256, u256, u256) {
    (x.chain_ref, x.asset_id, x.max_per_action, x.max_per_epoch, x.max_total)
}

public fun pe_chain_ref(e: &PolicyEndpoint): &vector<u8> { &e.chain_ref }
public fun pe_account(e: &PolicyEndpoint): &vector<u8> { &e.account }
public fun pe_epoch_seconds(e: &PolicyEndpoint): u64 { e.epoch_seconds }
public fun pe_adapters(e: &PolicyEndpoint): &vector<AdapterRef> { &e.adapters }
public fun pe_assets(e: &PolicyEndpoint): &vector<AssetLimit> { &e.assets }
public fun pe_recipients(e: &PolicyEndpoint): &vector<Recipient> { &e.recipients }
public fun pe_beneficiaries(e: &PolicyEndpoint): &vector<Recipient> { &e.beneficiaries }
public fun pe_swap_floors(e: &PolicyEndpoint): &vector<SwapFloor> { &e.swap_floors }
public fun pe_recovery_destinations(e: &PolicyEndpoint): &vector<Recipient> { &e.recovery_destinations }

public fun li_issuer(x: &LeaseIssuer): &vector<u8> { &x.issuer }
public fun li_max_lease_lifetime(x: &LeaseIssuer): u64 { x.max_lease_lifetime }
public fun li_allowed_agents(x: &LeaseIssuer): &vector<vector<u8>> { &x.allowed_agents }
public fun li_limits(x: &LeaseIssuer): &vector<IssuerLimit> { &x.limits }

public fun rp_account_id(p: &RootPolicy): &vector<u8> { &p.account_id }
public fun rp_policy_version(p: &RootPolicy): u64 { p.policy_version }
public fun rp_parent_policy_hash(p: &RootPolicy): &vector<u8> { &p.parent_policy_hash }
public fun rp_activate_before(p: &RootPolicy): u64 { p.activate_before }
public fun rp_allowed_actions(p: &RootPolicy): u32 { p.allowed_actions }
public fun rp_price_mode(p: &RootPolicy): u8 { p.price_mode }
public fun rp_max_lease_lifetime(p: &RootPolicy): u64 { p.max_lease_lifetime }
public fun rp_endpoints(p: &RootPolicy): &vector<PolicyEndpoint> { &p.endpoints }
public fun rp_lease_issuers(p: &RootPolicy): &vector<LeaseIssuer> { &p.lease_issuers }

public fun le_chain_ref(e: &LeaseEndpoint): &vector<u8> { &e.chain_ref }
public fun le_account(e: &LeaseEndpoint): &vector<u8> { &e.account }
public fun le_adapters(e: &LeaseEndpoint): &vector<vector<u8>> { &e.adapters }
public fun le_assets(e: &LeaseEndpoint): &vector<AssetLimit> { &e.assets }
public fun le_recipients(e: &LeaseEndpoint): &vector<vector<u8>> { &e.recipients }
public fun le_beneficiaries(e: &LeaseEndpoint): &vector<vector<u8>> { &e.beneficiaries }

public fun al_account_id(l: &AgentLease): &vector<u8> { &l.account_id }
public fun al_policy_version(l: &AgentLease): u64 { l.policy_version }
public fun al_lease_id(l: &AgentLease): &vector<u8> { &l.lease_id }
public fun al_agent(l: &AgentLease): &vector<u8> { &l.agent }
public fun al_issuer(l: &AgentLease): &vector<u8> { &l.issuer }
public fun al_valid_after(l: &AgentLease): u64 { l.valid_after }
public fun al_expires_at(l: &AgentLease): u64 { l.expires_at }
public fun al_activate_before(l: &AgentLease): u64 { l.activate_before }
public fun al_allowed_actions(l: &AgentLease): u32 { l.allowed_actions }
public fun al_auth_mode(l: &AgentLease): u8 { l.auth_mode }
public fun al_endpoints(l: &AgentLease): &vector<LeaseEndpoint> { &l.endpoints }

public fun ai_account_id(a: &ActionIntent): &vector<u8> { &a.account_id }
public fun ai_chain_ref(a: &ActionIntent): &vector<u8> { &a.chain_ref }
public fun ai_account(a: &ActionIntent): &vector<u8> { &a.account }
public fun ai_policy_version(a: &ActionIntent): u64 { a.policy_version }
public fun ai_lease_id(a: &ActionIntent): &vector<u8> { &a.lease_id }
public fun ai_nonce(a: &ActionIntent): u64 { a.nonce }
public fun ai_action_kind(a: &ActionIntent): u8 { a.action_kind }
public fun ai_adapter_id(a: &ActionIntent): &vector<u8> { &a.adapter_id }
public fun ai_adapter_name(a: &ActionIntent): &vector<u8> { &a.adapter_name }
public fun ai_adapter_version(a: &ActionIntent): u32 { a.adapter_version }
public fun ai_asset_in(a: &ActionIntent): &vector<u8> { &a.asset_in }
public fun ai_asset_out(a: &ActionIntent): &vector<u8> { &a.asset_out }
public fun ai_amount_in(a: &ActionIntent): u256 { a.amount_in }
public fun ai_min_amount_out(a: &ActionIntent): u256 { a.min_amount_out }
public fun ai_recipient(a: &ActionIntent): &vector<u8> { &a.recipient }
public fun ai_recipient_label(a: &ActionIntent): &vector<u8> { &a.recipient_label }
public fun ai_deadline(a: &ActionIntent): u64 { a.deadline }
public fun ai_plan_hash(a: &ActionIntent): &vector<u8> { &a.plan_hash }
public fun ai_plan_step(a: &ActionIntent): u32 { a.plan_step }

public fun pa_account_id(x: &PauseAccount): &vector<u8> { &x.account_id }
public fun pa_pause_epoch(x: &PauseAccount): u64 { x.pause_epoch }
public fun pa_pause_id(x: &PauseAccount): &vector<u8> { &x.pause_id }
public fun pa_deadline(x: &PauseAccount): u64 { x.deadline }

public fun ua_account_id(x: &UnpauseAccount): &vector<u8> { &x.account_id }
public fun ua_chain_ref(x: &UnpauseAccount): &vector<u8> { &x.chain_ref }
public fun ua_account(x: &UnpauseAccount): &vector<u8> { &x.account }
public fun ua_pause_epoch(x: &UnpauseAccount): u64 { x.pause_epoch }
public fun ua_pause_id(x: &UnpauseAccount): &vector<u8> { &x.pause_id }
public fun ua_deadline(x: &UnpauseAccount): u64 { x.deadline }

public fun rl_account_id(x: &RevokeLease): &vector<u8> { &x.account_id }
public fun rl_lease_id(x: &RevokeLease): &vector<u8> { &x.lease_id }

public fun wd_account_id(x: &Withdraw): &vector<u8> { &x.account_id }
public fun wd_chain_ref(x: &Withdraw): &vector<u8> { &x.chain_ref }
public fun wd_account(x: &Withdraw): &vector<u8> { &x.account }
public fun wd_asset_id(x: &Withdraw): &vector<u8> { &x.asset_id }
public fun wd_amount(x: &Withdraw): u256 { x.amount }
public fun wd_destination(x: &Withdraw): &vector<u8> { &x.destination }
public fun wd_op_nonce(x: &Withdraw): u64 { x.op_nonce }
public fun wd_deadline(x: &Withdraw): u64 { x.deadline }

// ---------------------------------------------------------------- encoding

public fun word_u256(x: u256): vector<u8> {
    let mut b = bcs::to_bytes(&x);
    b.reverse();
    b
}

fun word_u64(x: u64): vector<u8> { word_u256(x as u256) }

fun word_address(a: &vector<u8>): vector<u8> {
    let mut w = vector[];
    let mut i = 0u64;
    while (i < 12) {
        w.push_back(0);
        i = i + 1;
    };
    w.append(*a);
    w
}

fun keccak_of(parts: vector<vector<u8>>): vector<u8> {
    let mut buf = vector[];
    parts.do!(|p| buf.append(p));
    keccak256(&buf)
}

fun concat3(a: vector<u8>, b: vector<u8>, c: vector<u8>): vector<u8> {
    let mut x = a;
    x.append(b);
    x.append(c);
    x
}

fun cat(parts: vector<vector<u8>>): vector<u8> {
    let mut buf = vector[];
    parts.do!(|p| buf.append(p));
    buf
}

fun hash_bytes32_array(xs: &vector<vector<u8>>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| buf.append(*x));
    keccak256(&buf)
}

fun hash_address_array(xs: &vector<vector<u8>>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| buf.append(word_address(x)));
    keccak256(&buf)
}

// ---------------------------------------------------------------- type hashes

public fun type_hash_asset_limit(): vector<u8> { keccak256(&ASSET_LIMIT_T) }
public fun type_hash_adapter_ref(): vector<u8> { keccak256(&ADAPTER_REF_T) }
public fun type_hash_recipient(): vector<u8> { keccak256(&RECIPIENT_T) }
public fun type_hash_swap_floor(): vector<u8> { keccak256(&SWAP_FLOOR_T) }
public fun type_hash_issuer_limit(): vector<u8> { keccak256(&ISSUER_LIMIT_T) }
public fun type_hash_lease_issuer(): vector<u8> { keccak256(&cat(vector[LEASE_ISSUER_T, ISSUER_LIMIT_T])) }

public fun type_hash_policy_endpoint(): vector<u8> {
    keccak256(&cat(vector[POLICY_ENDPOINT_T, ADAPTER_REF_T, ASSET_LIMIT_T, RECIPIENT_T, SWAP_FLOOR_T]))
}

public fun type_hash_root_policy(): vector<u8> {
    keccak256(
        &cat(vector[
            ROOT_POLICY_T,
            ADAPTER_REF_T,
            ASSET_LIMIT_T,
            ISSUER_LIMIT_T,
            LEASE_ISSUER_T,
            POLICY_ENDPOINT_T,
            RECIPIENT_T,
            SWAP_FLOOR_T,
        ]),
    )
}

public fun type_hash_lease_endpoint(): vector<u8> { keccak256(&cat(vector[LEASE_ENDPOINT_T, ASSET_LIMIT_T])) }

public fun type_hash_agent_lease(): vector<u8> {
    keccak256(&cat(vector[AGENT_LEASE_T, ASSET_LIMIT_T, LEASE_ENDPOINT_T]))
}

public fun type_hash_action_intent(): vector<u8> { keccak256(&ACTION_INTENT_T) }
public fun type_hash_pause_account(): vector<u8> { keccak256(&PAUSE_ACCOUNT_T) }
public fun type_hash_unpause_account(): vector<u8> { keccak256(&UNPAUSE_ACCOUNT_T) }
public fun type_hash_revoke_lease(): vector<u8> { keccak256(&REVOKE_LEASE_T) }
public fun type_hash_withdraw(): vector<u8> { keccak256(&WITHDRAW_T) }

// ---------------------------------------------------------------- struct hashes

public fun hash_asset_limit(x: &AssetLimit): vector<u8> {
    keccak_of(vector[
        type_hash_asset_limit(),
        x.asset_id,
        word_u256(x.max_per_action),
        word_u256(x.max_per_epoch),
        word_u256(x.max_total),
    ])
}

fun hash_asset_limits(xs: &vector<AssetLimit>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| buf.append(hash_asset_limit(x)));
    keccak256(&buf)
}

fun hash_adapter_refs(xs: &vector<AdapterRef>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| {
        buf.append(
            keccak_of(vector[
                type_hash_adapter_ref(),
                x.adapter_id,
                keccak256(&x.adapter_name),
                word_u256(x.adapter_version as u256),
            ]),
        )
    });
    keccak256(&buf)
}

fun hash_recipients(xs: &vector<Recipient>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| buf.append(keccak_of(vector[type_hash_recipient(), x.recipient_id, keccak256(&x.label)])));
    keccak256(&buf)
}

fun hash_swap_floors(xs: &vector<SwapFloor>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| {
        buf.append(
            keccak_of(vector[
                type_hash_swap_floor(),
                x.asset_in,
                x.asset_out,
                word_u256(x.min_out_numerator),
                word_u256(x.min_out_denominator),
            ]),
        )
    });
    keccak256(&buf)
}

fun hash_issuer_limits(xs: &vector<IssuerLimit>): vector<u8> {
    let mut buf = vector[];
    xs.do_ref!(|x| {
        buf.append(
            keccak_of(vector[
                type_hash_issuer_limit(),
                x.chain_ref,
                x.asset_id,
                word_u256(x.max_per_action),
                word_u256(x.max_per_epoch),
                word_u256(x.max_total),
            ]),
        )
    });
    keccak256(&buf)
}

public fun hash_policy_endpoint(e: &PolicyEndpoint): vector<u8> {
    keccak_of(vector[
        type_hash_policy_endpoint(),
        e.chain_ref,
        e.account,
        word_u64(e.epoch_seconds),
        hash_adapter_refs(&e.adapters),
        hash_asset_limits(&e.assets),
        hash_recipients(&e.recipients),
        hash_recipients(&e.beneficiaries),
        hash_swap_floors(&e.swap_floors),
        hash_recipients(&e.recovery_destinations),
    ])
}

public fun hash_lease_issuer(x: &LeaseIssuer): vector<u8> {
    keccak_of(vector[
        type_hash_lease_issuer(),
        word_address(&x.issuer),
        word_u64(x.max_lease_lifetime),
        hash_address_array(&x.allowed_agents),
        hash_issuer_limits(&x.limits),
    ])
}

public fun hash_root_policy(p: &RootPolicy): vector<u8> {
    let mut eps = vector[];
    p.endpoints.do_ref!(|e| eps.append(hash_policy_endpoint(e)));
    let mut iss = vector[];
    p.lease_issuers.do_ref!(|x| iss.append(hash_lease_issuer(x)));
    keccak_of(vector[
        type_hash_root_policy(),
        p.account_id,
        word_u64(p.policy_version),
        p.parent_policy_hash,
        word_u256(p.allowed_actions as u256),
        word_u256(p.price_mode as u256),
        word_u64(p.max_lease_lifetime),
        word_u64(p.activate_before),
        keccak256(&eps),
        keccak256(&iss),
    ])
}

public fun hash_lease_endpoint(e: &LeaseEndpoint): vector<u8> {
    keccak_of(vector[
        type_hash_lease_endpoint(),
        e.chain_ref,
        e.account,
        hash_bytes32_array(&e.adapters),
        hash_asset_limits(&e.assets),
        hash_bytes32_array(&e.recipients),
        hash_bytes32_array(&e.beneficiaries),
    ])
}

public fun hash_agent_lease(l: &AgentLease): vector<u8> {
    let mut eps = vector[];
    l.endpoints.do_ref!(|e| eps.append(hash_lease_endpoint(e)));
    keccak_of(vector[
        type_hash_agent_lease(),
        l.account_id,
        word_u64(l.policy_version),
        l.lease_id,
        word_address(&l.agent),
        word_address(&l.issuer),
        word_u64(l.valid_after),
        word_u64(l.expires_at),
        word_u64(l.activate_before),
        word_u256(l.allowed_actions as u256),
        word_u256(l.auth_mode as u256),
        keccak256(&eps),
    ])
}

public fun hash_action_intent(a: &ActionIntent): vector<u8> {
    keccak_of(vector[
        type_hash_action_intent(),
        a.account_id,
        a.chain_ref,
        a.account,
        word_u64(a.policy_version),
        a.lease_id,
        word_u64(a.nonce),
        word_u256(a.action_kind as u256),
        a.adapter_id,
        keccak256(&a.adapter_name),
        word_u256(a.adapter_version as u256),
        a.asset_in,
        a.asset_out,
        word_u256(a.amount_in),
        word_u256(a.min_amount_out),
        a.recipient,
        keccak256(&a.recipient_label),
        word_u64(a.deadline),
        a.plan_hash,
        word_u256(a.plan_step as u256),
    ])
}

public fun hash_pause_account(x: &PauseAccount): vector<u8> {
    keccak_of(vector[type_hash_pause_account(), x.account_id, word_u64(x.pause_epoch), x.pause_id, word_u64(x.deadline)])
}

public fun hash_unpause_account(x: &UnpauseAccount): vector<u8> {
    keccak_of(vector[
        type_hash_unpause_account(),
        x.account_id,
        x.chain_ref,
        x.account,
        word_u64(x.pause_epoch),
        x.pause_id,
        word_u64(x.deadline),
    ])
}

public fun hash_revoke_lease(x: &RevokeLease): vector<u8> {
    keccak_of(vector[type_hash_revoke_lease(), x.account_id, x.lease_id])
}

public fun hash_withdraw(x: &Withdraw): vector<u8> {
    keccak_of(vector[
        type_hash_withdraw(),
        x.account_id,
        x.chain_ref,
        x.account,
        x.asset_id,
        word_u256(x.amount),
        x.destination,
        word_u64(x.op_nonce),
        word_u64(x.deadline),
    ])
}

// ---------------------------------------------------------------- domain + digest

public fun domain_separator(): vector<u8> {
    keccak_of(vector[
        keccak256(&b"EIP712Domain(string name,string version,uint256 chainId)"),
        keccak256(&b"Amane"),
        keccak256(&b"1"),
        word_u256(SIGNING_CHAIN_ID),
    ])
}

public fun preimage(struct_hash: vector<u8>): vector<u8> {
    concat3(x"1901", domain_separator(), struct_hash)
}

public fun digest(struct_hash: vector<u8>): vector<u8> { keccak256(&preimage(struct_hash)) }

public fun recover_signer(struct_hash: vector<u8>, signature: &vector<u8>): vector<u8> {
    crypto::recover_eth_address(&preimage(struct_hash), signature)
}
