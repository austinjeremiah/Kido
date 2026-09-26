#[allow(implicit_const_copy)]
/// Amane endpoint for one logical account on Sui: a shared vault object whose value can only
/// leave through (a) an agent action proven to be ⊆ Lease ⊆ RootPolicy, or (b) a root-controller
/// withdrawal to a pinned recovery destination.
///
/// Adapter dispatch uses a hot-potato `ActionTicket<W, In>`: `authorize` verifies, debits budget,
/// marks the nonce and moves the exact input into the ticket; only the adapter that owns witness
/// `W` can take the input, and the PTB aborts unless the same adapter calls `settle`, which
/// deposits the output into the vault and checks the minimum itself.
///
/// Cross-chain (core v5): a BRIDGE action hands its exact input to a witness-bound transport
/// adapter through a `BridgeTicket` that carries the payload the adapter must send
/// (`intent ‖ destination endpoint`). Arrivals are reserved for the one agent-signed source intent
/// whose committed `DestSpec` they match; ordinary actions cannot spend reserved or quarantined
/// funds, and an arrival whose destination can no longer run is quarantined for root recovery.
module amane::account;

use amane::eip712::{Self, RootPolicy, AgentLease, ActionIntent, PauseAccount, UnpauseAccount, RevokeLease, Withdraw};
use std::type_name;
use sui::address;
use sui::bag::{Self, Bag};
use sui::balance::{Self, Balance};
use sui::bcs;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::hash::keccak256;
use sui::table::{Self, Table};
use sui::transfer::Receiving;
use sui::vec_map::{Self, VecMap};

// ---------------------------------------------------------------- error codes (AMANE_*)

const EPolicyWrongAccount: u64 = 1000;
const EPolicyVersionMismatch: u64 = 1001;
const EPolicyWrongEndpoint: u64 = 1002;
const EPolicyBadPriceMode: u64 = 1003;
const EPolicyBadEpoch: u64 = 1004;
const EPolicyBadFloor: u64 = 1005;
const EPolicyIssuerIsController: u64 = 1006;
const EPolicyDuplicateEntry: u64 = 1007;
const EPolicyParentMismatch: u64 = 1008;
const EPolicyActivationExpired: u64 = 1009;
const EControllerThreshold: u64 = 1100;
const EControllerUnsorted: u64 = 1101;
const EControllerNotAuthorized: u64 = 1102;
const EControllerBadConfig: u64 = 1103;
const ELeaseBadAuthMode: u64 = 1200;
const ELeaseBadWindow: u64 = 1201;
const ELeaseActivationExpired: u64 = 1202;
const ELeaseLifetimeExceeded: u64 = 1203;
const ELeaseActionNotInRoot: u64 = 1204;
const ELeaseIdReplay: u64 = 1205;
const ELeaseIssuerNotAuthorized: u64 = 1206;
const ELeaseAgentIsIssuer: u64 = 1207;
const ELeaseAgentNotAllowed: u64 = 1208;
const ELeaseWrongEndpoint: u64 = 1209;
const ELeaseAdapterNotInRoot: u64 = 1210;
const ELeaseAssetNotInRoot: u64 = 1211;
const ELeaseCapExceedsRoot: u64 = 1212;
const ELeaseCapExceedsIssuer: u64 = 1213;
const ELeaseRecipientNotInRoot: u64 = 1214;
const ELeaseBeneficiaryNotInRoot: u64 = 1215;
const ELeaseDuplicateEntry: u64 = 1216;
const ELeaseNotActive: u64 = 1217;
const ELeaseNotYetValid: u64 = 1218;
const ELeaseExpired: u64 = 1219;
const EActionPaused: u64 = 1300;
const EActionWrongEndpoint: u64 = 1301;
const EActionExpired: u64 = 1302;
const EActionWrongAgent: u64 = 1303;
const EActionNonceReplay: u64 = 1304;
const EActionKindNotAllowed: u64 = 1305;
const EActionAdapterNotAllowed: u64 = 1306;
const EActionAdapterNameMismatch: u64 = 1307;
const EActionAdapterWitnessMismatch: u64 = 1308;
const EActionAssetNotAllowed: u64 = 1309;
const EActionRecipientNotAllowed: u64 = 1310;
const EActionZeroAmount: u64 = 1311;
const EActionNoPriceFloor: u64 = 1312;
const EActionBelowMinOut: u64 = 1313;
const EActionOverspent: u64 = 1314;
const EActionAmountTooLarge: u64 = 1315;
const ETicketWrongAccount: u64 = 1316;
const ETicketInputAlreadyTaken: u64 = 1317;
const EBudgetPerAction: u64 = 1400;
const EBudgetEpoch: u64 = 1401;
const EBudgetTotal: u64 = 1402;
const EReplayPauseEpoch: u64 = 1500;
const EReplayOpNonce: u64 = 1501;
const EOwnerDestinationNotAllowed: u64 = 1600;
const EInsufficientVault: u64 = 1601;
const EXchainNotABridgeAction: u64 = 1800;
const EXchainWrongDestination: u64 = 1801;
const EXchainSpecMismatch: u64 = 1802;
const EXchainPayloadMismatch: u64 = 1803;
const EXchainWrongAsset: u64 = 1804;
const EXchainBelowMinimum: u64 = 1805;
const EXchainIntentUsed: u64 = 1806;
const EXchainExpired: u64 = 1807;
const EXchainNoReservation: u64 = 1808;
const EXchainReservationMismatch: u64 = 1809;
const EXchainReservedFunds: u64 = 1810;

const PRICE_MODE_TESTNET_FIXED: u8 = 1;
const AUTH_MODE_AGENT_SIGNED: u8 = 1;
const KIND_SWAP: u8 = 0;
const KIND_PAY: u8 = 9;
const KIND_BRIDGE: u8 = 10;
const CORE_VERSION: u64 = 5;

const LEASE_ACTIVE: u8 = 1;
const LEASE_REVOKED: u8 = 2;

const ADAPTER_TAG_PREIMAGE: vector<u8> = b"AMANE_ADAPTER_V1";
const DEST_SPEC_TAG_PREIMAGE: vector<u8> = b"AMANE_DEST_SPEC_V1";

// ---------------------------------------------------------------- state

public struct Limit has copy, drop, store {
    per_action: u256,
    per_epoch: u256,
    total: u256,
}

/// Token bucket: `level` refills linearly to per_epoch over epoch_seconds, so spend within any
/// window of length W is at most per_epoch * (1 + W / epoch_seconds).
public struct Spend has copy, drop, store {
    updated_at: u64,
    level: u256,
    total_spent: u256,
}

public struct AdapterPolicy has copy, drop, store {
    name_hash: vector<u8>,
    version: u32,
}

public struct Floor has copy, drop, store {
    num: u256,
    den: u256,
}

public struct IssuerPolicy has copy, drop, store {
    max_lease_lifetime: u64,
    agents: vector<vector<u8>>,
    limits: VecMap<vector<u8>, Limit>,
}

public struct StoredPolicy has copy, drop, store {
    version: u64,
    hash: vector<u8>,
    allowed_actions: u32,
    max_lease_lifetime: u64,
    epoch_seconds: u64,
    adapters: VecMap<vector<u8>, AdapterPolicy>,
    assets: VecMap<vector<u8>, Limit>,
    recipients: VecMap<vector<u8>, vector<u8>>,
    beneficiaries: VecMap<vector<u8>, vector<u8>>,
    recovery: vector<vector<u8>>,
    floors: VecMap<vector<u8>, Floor>,
    issuers: VecMap<vector<u8>, IssuerPolicy>,
}

public struct Lease has copy, drop, store {
    status: u8,
    by_controller: bool,
    policy_version: u64,
    agent: vector<u8>,
    issuer: vector<u8>,
    valid_after: u64,
    expires_at: u64,
    allowed_actions: u32,
    adapters: vector<vector<u8>>,
    assets: VecMap<vector<u8>, Limit>,
    recipients: vector<vector<u8>>,
    beneficiaries: vector<vector<u8>>,
}

public struct Account has key {
    id: UID,
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    controllers: vector<vector<u8>>,
    threshold: u8,
    paused: bool,
    pause_epoch: u64,
    last_pause_id: vector<u8>,
    pause_ids: Table<vector<u8>, bool>,
    op_nonce: u64,
    policy: Option<StoredPolicy>,
    leases: Table<vector<u8>, Lease>,
    nonces: Table<vector<u8>, bool>,
    spend: Table<vector<u8>, Spend>,
    vault: Bag,
    intents_used: Table<vector<u8>, bool>,
    reservations: Table<vector<u8>, Reservation>,
    /// Per asset: everything ordinary actions may not spend (live reservations + quarantine).
    reserved: Table<vector<u8>, u64>,
    /// Per asset: the part of `reserved` that only a root-threshold withdrawal can move.
    quarantined: Table<vector<u8>, u64>,
}

/// What the source intent committed the arrival to, hashed exactly like the EVM `DestSpecHash`.
public struct DestSpec has copy, drop, store {
    action_kind: u8,
    adapter_id: vector<u8>,
    recipient: vector<u8>,
    recipient_label: vector<u8>,
    asset: vector<u8>,
    min_arrival: u256,
    deadline: u64,
}

public struct Reservation has copy, drop, store {
    lease_id: vector<u8>,
    action_kind: u8,
    adapter_id: vector<u8>,
    recipient: vector<u8>,
    asset: vector<u8>,
    deadline: u64,
    remaining: u64,
}

/// Hot potato for BRIDGE. Only the transport adapter owning `W` can take the input, and it must
/// send exactly `payload` to `recipient`'s chain before `settle_bridge` consumes the ticket.
public struct BridgeTicket<phantom W, phantom In> {
    account: ID,
    intent: vector<u8>,
    recipient: vector<u8>,
    amount: u64,
    input: Option<Balance<In>>,
}

/// Hot potato. No abilities: it cannot be dropped, stored, copied or transferred, so the PTB
/// that created it must hand it to `settle` in the same transaction.
public struct ActionTicket<phantom W, phantom In> {
    account: ID,
    action_hash: vector<u8>,
    adapter_id: vector<u8>,
    asset_out: vector<u8>,
    amount_in: u64,
    min_out: u64,
    input: Option<Balance<In>>,
}

/// Witness for the core-native PAY adapter. Only this module can construct it.
public struct TransferPayV1 has drop {}

// ---------------------------------------------------------------- events

public struct AccountCreated has copy, drop { object: ID, account_id: vector<u8>, chain_ref: vector<u8> }
public struct PolicyInstalled has copy, drop { object: ID, version: u64, hash: vector<u8> }
public struct LeaseActivated has copy, drop { object: ID, lease_id: vector<u8>, agent: vector<u8>, issuer: vector<u8>, expires_at: u64 }
public struct LeaseRevoked has copy, drop { object: ID, lease_id: vector<u8>, by: vector<u8> }
public struct AccountPaused has copy, drop { object: ID, pause_epoch: u64, pause_id: vector<u8>, by: vector<u8> }
public struct AccountUnpaused has copy, drop { object: ID, pause_epoch: u64, pause_id: vector<u8> }
public struct ActionAuthorized has copy, drop {
    object: ID,
    lease_id: vector<u8>,
    nonce: u64,
    action_kind: u8,
    adapter_id: vector<u8>,
    amount_in: u64,
    min_out: u64,
    plan_hash: vector<u8>,
    plan_step: u32,
}
public struct ActionSettled has copy, drop { object: ID, action_hash: vector<u8>, amount_out: u64, refunded: u64 }
public struct Deposited has copy, drop { object: ID, asset_id: vector<u8>, amount: u64 }
public struct Withdrawn has copy, drop { object: ID, asset_id: vector<u8>, amount: u64, destination: address, op_nonce: u64 }
public struct BridgeSent has copy, drop { object: ID, intent: vector<u8>, recipient: vector<u8>, amount: u64 }
public struct CrossChainReserved has copy, drop { object: ID, intent: vector<u8>, lease_id: vector<u8>, asset_id: vector<u8>, amount: u64 }
public struct CrossChainQuarantined has copy, drop { object: ID, intent: vector<u8>, asset_id: vector<u8>, amount: u64 }

// ---------------------------------------------------------------- creation + deposits

/// `chain_ref` is asserted by the creator because Move cannot read the chain identifier; clients
/// verify it against the live chain before signing, and every signed struct binds the object ID.
public fun create(
    account_id: vector<u8>,
    chain_ref: vector<u8>,
    controllers: vector<vector<u8>>,
    threshold: u8,
    ctx: &mut TxContext,
): ID {
    assert!(account_id.length() == 32 && chain_ref.length() == 32, EControllerBadConfig);
    let n = controllers.length();
    assert!(n > 0 && threshold > 0 && (threshold as u64) <= n, EControllerBadConfig);
    let mut i = 0;
    while (i < n) {
        assert!(controllers[i].length() == 20, EControllerBadConfig);
        if (i > 0) assert!(lt_bytes(&controllers[i - 1], &controllers[i]), EControllerUnsorted);
        i = i + 1;
    };
    let account = Account {
        id: object::new(ctx),
        account_id,
        chain_ref,
        controllers,
        threshold,
        paused: false,
        pause_epoch: 0,
        last_pause_id: vector[],
        pause_ids: table::new(ctx),
        op_nonce: 0,
        policy: option::none(),
        leases: table::new(ctx),
        nonces: table::new(ctx),
        spend: table::new(ctx),
        vault: bag::new(ctx),
        intents_used: table::new(ctx),
        reservations: table::new(ctx),
        reserved: table::new(ctx),
        quarantined: table::new(ctx),
    };
    let object = object::id(&account);
    event::emit(AccountCreated { object, account_id: account.account_id, chain_ref: account.chain_ref });
    transfer::share_object(account);
    object
}

public fun deposit<T>(self: &mut Account, coin: Coin<T>) {
    let amount = coin.value();
    deposit_balance(self, coin.into_balance());
    event::emit(Deposited { object: object::id(self), asset_id: asset_id<T>(), amount });
}

/// Receives coins that were sent to the account's object ID with `transfer::public_transfer`.
public fun receive<T>(self: &mut Account, sent: Receiving<Coin<T>>) {
    let coin = transfer::public_receive(&mut self.id, sent);
    deposit(self, coin);
}

// ---------------------------------------------------------------- root controller paths

public fun install_policy(self: &mut Account, p: RootPolicy, sigs: vector<vector<u8>>, clock: &Clock) {
    assert!(eip712::rp_account_id(&p) == &self.account_id, EPolicyWrongAccount);
    assert!(eip712::rp_policy_version(&p) == policy_version(self) + 1, EPolicyVersionMismatch);
    assert!(eip712::rp_price_mode(&p) == PRICE_MODE_TESTNET_FIXED, EPolicyBadPriceMode);
    let parent = if (self.policy.is_some()) self.policy.borrow().hash else zero32();
    assert!(eip712::rp_parent_policy_hash(&p) == &parent, EPolicyParentMismatch);
    assert!(now_seconds(clock) <= eip712::rp_activate_before(&p), EPolicyActivationExpired);
    let h = eip712::hash_root_policy(&p);
    require_threshold(self, h, &sigs);

    let me = self32(self);
    let mut found = option::none();
    eip712::rp_endpoints(&p).do_ref!(|e| {
        if (eip712::pe_chain_ref(e) == &self.chain_ref && eip712::pe_account(e) == &me) {
            assert!(found.is_none(), EPolicyDuplicateEntry);
            found.fill(*e);
        }
    });
    assert!(found.is_some(), EPolicyWrongEndpoint);
    let e = found.destroy_some();
    assert!(eip712::pe_epoch_seconds(&e) > 0, EPolicyBadEpoch);

    let mut adapters = vec_map::empty();
    eip712::pe_adapters(&e).do_ref!(|a| {
        let (id, name, version) = eip712::adapter_ref_fields(a);
        assert!(!adapters.contains(&id), EPolicyDuplicateEntry);
        adapters.insert(id, AdapterPolicy { name_hash: keccak256(&name), version });
    });
    let mut assets = vec_map::empty();
    eip712::pe_assets(&e).do_ref!(|a| {
        let (id, pa, pe, t) = eip712::asset_limit_fields(a);
        assert!(!assets.contains(&id), EPolicyDuplicateEntry);
        assets.insert(id, Limit { per_action: pa, per_epoch: pe, total: t });
    });
    let recipients = label_map(eip712::pe_recipients(&e));
    let beneficiaries = label_map(eip712::pe_beneficiaries(&e));
    let recovery_map = label_map(eip712::pe_recovery_destinations(&e));
    let mut floors = vec_map::empty();
    eip712::pe_swap_floors(&e).do_ref!(|f| {
        let (asset_in, asset_out, num, den) = eip712::swap_floor_fields(f);
        assert!(den != 0 && num != 0, EPolicyBadFloor);
        let key = pair_key(&asset_in, &asset_out);
        assert!(!floors.contains(&key), EPolicyDuplicateEntry);
        floors.insert(key, Floor { num, den });
    });
    let mut issuers = vec_map::empty();
    eip712::rp_lease_issuers(&p).do_ref!(|x| {
        let issuer = *eip712::li_issuer(x);
        assert!(!self.controllers.contains(&issuer), EPolicyIssuerIsController);
        assert!(!issuers.contains(&issuer), EPolicyDuplicateEntry);
        let mut limits = vec_map::empty();
        eip712::li_limits(x).do_ref!(|l| {
            let (chain_ref, asset, pa, pe, t) = eip712::issuer_limit_fields(l);
            if (chain_ref == self.chain_ref) {
                assert!(!limits.contains(&asset), EPolicyDuplicateEntry);
                limits.insert(asset, Limit { per_action: pa, per_epoch: pe, total: t });
            }
        });
        issuers.insert(
            issuer,
            IssuerPolicy { max_lease_lifetime: eip712::li_max_lease_lifetime(x), agents: *eip712::li_allowed_agents(x), limits },
        );
    });

    let version = eip712::rp_policy_version(&p);
    self.policy =
        option::some(StoredPolicy {
            version,
            hash: h,
            allowed_actions: eip712::rp_allowed_actions(&p),
            max_lease_lifetime: eip712::rp_max_lease_lifetime(&p),
            epoch_seconds: eip712::pe_epoch_seconds(&e),
            adapters,
            assets,
            recipients,
            beneficiaries,
            recovery: recovery_map.keys(),
            floors,
            issuers,
        });
    event::emit(PolicyInstalled { object: object::id(self), version, hash: h });
}

/// Reduction path: one controller signature, relayable by anyone. Bound to the current pause
/// epoch, which only a threshold unpause advances, so it cannot be exhausted and stale pause
/// signatures die after the next unpause.
public fun pause(self: &mut Account, x: PauseAccount, sig: vector<u8>, clock: &Clock) {
    assert!(eip712::pa_account_id(&x) == &self.account_id, EPolicyWrongAccount);
    assert!(eip712::pa_pause_epoch(&x) == self.pause_epoch, EReplayPauseEpoch);
    assert!(now_seconds(clock) <= eip712::pa_deadline(&x), EActionExpired);
    let signer = eip712::recover_signer(eip712::hash_pause_account(&x), &sig);
    assert!(self.controllers.contains(&signer), EControllerNotAuthorized);
    // Single-use ids: replaying an earlier pause must not restore it as `last_pause_id`, or a
    // withheld unpause for that earlier pause would lift the current one.
    let pause_id = *eip712::pa_pause_id(&x);
    assert!(!self.pause_ids.contains(pause_id), EReplayPauseEpoch);
    self.pause_ids.add(pause_id, true);
    self.paused = true;
    self.last_pause_id = pause_id;
    event::emit(AccountPaused { object: object::id(self), pause_epoch: self.pause_epoch, pause_id: self.last_pause_id, by: signer });
}

/// Lifts only the exact pause its signers saw; a later pause invalidates a withheld unpause.
public fun unpause(self: &mut Account, x: UnpauseAccount, sigs: vector<vector<u8>>, clock: &Clock) {
    assert!(eip712::ua_account_id(&x) == &self.account_id, EPolicyWrongAccount);
    assert!(eip712::ua_chain_ref(&x) == &self.chain_ref && eip712::ua_account(&x) == &self32(self), EActionWrongEndpoint);
    assert!(
        self.paused && eip712::ua_pause_epoch(&x) == self.pause_epoch && eip712::ua_pause_id(&x) == &self.last_pause_id,
        EReplayPauseEpoch,
    );
    assert!(now_seconds(clock) <= eip712::ua_deadline(&x), EActionExpired);
    require_threshold(self, eip712::hash_unpause_account(&x), &sigs);
    self.paused = false;
    self.pause_epoch = self.pause_epoch + 1;
    event::emit(AccountUnpaused { object: object::id(self), pause_epoch: eip712::ua_pause_epoch(&x), pause_id: self.last_pause_id });
}

public fun revoke_lease(self: &mut Account, x: RevokeLease, sig: vector<u8>) {
    assert!(eip712::rl_account_id(&x) == &self.account_id, EPolicyWrongAccount);
    let signer = eip712::recover_signer(eip712::hash_revoke_lease(&x), &sig);
    let lease_id = *eip712::rl_lease_id(&x);
    let known = self.leases.contains(lease_id);
    let allowed = self.controllers.contains(&signer)
        || (known && self.leases[lease_id].status == LEASE_ACTIVE && self.leases[lease_id].issuer == signer);
    assert!(allowed, EControllerNotAuthorized);
    if (known) {
        self.leases.borrow_mut(lease_id).status = LEASE_REVOKED;
    } else {
        self.leases.add(lease_id, revoked_placeholder());
    };
    event::emit(LeaseRevoked { object: object::id(self), lease_id, by: signer });
}

public fun withdraw<T>(self: &mut Account, x: Withdraw, sigs: vector<vector<u8>>, clock: &Clock, ctx: &mut TxContext) {
    assert!(eip712::wd_account_id(&x) == &self.account_id, EPolicyWrongAccount);
    assert!(eip712::wd_chain_ref(&x) == &self.chain_ref && eip712::wd_account(&x) == &self32(self), EActionWrongEndpoint);
    assert!(eip712::wd_op_nonce(&x) == self.op_nonce, EReplayOpNonce);
    assert!(now_seconds(clock) <= eip712::wd_deadline(&x), EActionExpired);
    assert!(eip712::wd_asset_id(&x) == &asset_id<T>(), EActionAssetNotAllowed);
    assert!(self.policy.is_some() && self.policy.borrow().recovery.contains(eip712::wd_destination(&x)), EOwnerDestinationNotAllowed);
    require_threshold(self, eip712::hash_withdraw(&x), &sigs);
    self.op_nonce = self.op_nonce + 1;
    let amount = to_u64(eip712::wd_amount(&x));
    let destination = address::from_bytes(*eip712::wd_destination(&x));
    let asset = asset_id<T>();
    let q = counter(&self.quarantined, &asset);
    let live = counter(&self.reserved, &asset) - q;
    assert!(vault_balance<T>(self) - live >= amount, EXchainReservedFunds);
    let from_q = if (amount < q) amount else q;
    sub_counter(&mut self.quarantined, asset, from_q);
    sub_counter(&mut self.reserved, asset, from_q);
    let out = take_from_vault<T>(self, amount);
    transfer::public_transfer(coin::from_balance(out, ctx), destination);
    event::emit(Withdrawn { object: object::id(self), asset_id: asset_id<T>(), amount, destination, op_nonce: eip712::wd_op_nonce(&x) });
}

// ---------------------------------------------------------------- lease issuance

public fun activate_lease(self: &mut Account, l: AgentLease, sig: vector<u8>, clock: &Clock) {
    assert!(eip712::al_account_id(&l) == &self.account_id, EPolicyWrongAccount);
    assert!(self.policy.is_some(), EPolicyVersionMismatch);
    let policy = *self.policy.borrow();
    let v = policy.version;
    assert!(eip712::al_policy_version(&l) == v, EPolicyVersionMismatch);
    assert!(eip712::al_auth_mode(&l) == AUTH_MODE_AGENT_SIGNED, ELeaseBadAuthMode);
    let valid_after = eip712::al_valid_after(&l);
    let expires_at = eip712::al_expires_at(&l);
    assert!(expires_at > valid_after, ELeaseBadWindow);
    assert!(now_seconds(clock) <= eip712::al_activate_before(&l), ELeaseActivationExpired);
    let lifetime = expires_at - valid_after;
    assert!(lifetime <= policy.max_lease_lifetime, ELeaseLifetimeExceeded);
    let allowed_actions = eip712::al_allowed_actions(&l);
    assert!(allowed_actions & (policy.allowed_actions ^ 0xffffffffu32) == 0, ELeaseActionNotInRoot);
    let lease_id = *eip712::al_lease_id(&l);
    assert!(!self.leases.contains(lease_id), ELeaseIdReplay);

    let signer = eip712::recover_signer(eip712::hash_agent_lease(&l), &sig);
    assert!(&signer == eip712::al_issuer(&l), ELeaseIssuerNotAuthorized);
    let agent = *eip712::al_agent(&l);
    assert!(agent != signer && !self.controllers.contains(&agent), ELeaseAgentIsIssuer);
    let by_controller = self.controllers.contains(&signer);
    if (!by_controller) {
        assert!(policy.issuers.contains(&signer), ELeaseIssuerNotAuthorized);
        let ip = policy.issuers.get(&signer);
        assert!(lifetime <= ip.max_lease_lifetime, ELeaseLifetimeExceeded);
        assert!(ip.agents.contains(&agent), ELeaseAgentNotAllowed);
    };

    let me = self32(self);
    let mut found = option::none();
    eip712::al_endpoints(&l).do_ref!(|e| {
        if (eip712::le_chain_ref(e) == &self.chain_ref && eip712::le_account(e) == &me) {
            assert!(found.is_none(), ELeaseDuplicateEntry);
            found.fill(*e);
        }
    });
    assert!(found.is_some(), ELeaseWrongEndpoint);
    let e = found.destroy_some();

    let adapters = *eip712::le_adapters(&e);
    assert_unique(&adapters);
    adapters.do_ref!(|a| assert!(policy.adapters.contains(a), ELeaseAdapterNotInRoot));

    let mut assets = vec_map::empty();
    eip712::le_assets(&e).do_ref!(|a| {
        let (id, pa, pe, t) = eip712::asset_limit_fields(a);
        assert!(policy.assets.contains(&id), ELeaseAssetNotInRoot);
        let r = policy.assets.get(&id);
        assert!(pa <= r.per_action && pe <= r.per_epoch && t <= r.total, ELeaseCapExceedsRoot);
        if (!by_controller) {
            let c = issuer_limit(&policy, &signer, &id);
            assert!(pa <= c.per_action && pe <= c.per_epoch && t <= c.total, ELeaseCapExceedsIssuer);
        };
        assert!(!assets.contains(&id), ELeaseDuplicateEntry);
        assets.insert(id, Limit { per_action: pa, per_epoch: pe, total: t });
    });

    let recipients = *eip712::le_recipients(&e);
    assert_unique(&recipients);
    recipients.do_ref!(|r| assert!(policy.recipients.contains(r), ELeaseRecipientNotInRoot));
    let beneficiaries = *eip712::le_beneficiaries(&e);
    assert_unique(&beneficiaries);
    beneficiaries.do_ref!(|r| assert!(policy.beneficiaries.contains(r), ELeaseBeneficiaryNotInRoot));

    self
        .leases
        .add(
            lease_id,
            Lease {
                status: LEASE_ACTIVE,
                by_controller,
                policy_version: v,
                agent,
                issuer: signer,
                valid_after,
                expires_at,
                allowed_actions,
                adapters,
                assets,
                recipients,
                beneficiaries,
            },
        );
    event::emit(LeaseActivated { object: object::id(self), lease_id, agent, issuer: signer, expires_at });
}

// ---------------------------------------------------------------- agent action path

/// Verifies the agent's signed intent against lease and policy, debits every budget, marks the
/// nonce and moves the exact input out of the vault into the returned ticket. Anyone may call
/// this (executors are untrusted); nothing here depends on the caller.
public fun authorize<W: drop, In>(self: &mut Account, a: ActionIntent, sig: vector<u8>, clock: &Clock): ActionTicket<W, In> {
    let kind = eip712::ai_action_kind(&a);
    assert!(kind == KIND_SWAP, EActionKindNotAllowed);
    let (action_hash, amount_in) = verify<W, In>(self, &a, &sig, clock);

    let lease = self.leases[*eip712::ai_lease_id(&a)];
    let asset_out = *eip712::ai_asset_out(&a);
    assert!(&asset_out != eip712::ai_asset_in(&a), EActionAssetNotAllowed);
    assert!(lease.assets.contains(&asset_out), EActionAssetNotAllowed);
    assert!(eip712::ai_recipient(&a) == &zero32(), EActionRecipientNotAllowed);
    let policy = self.policy.borrow();
    let key = pair_key(eip712::ai_asset_in(&a), &asset_out);
    assert!(policy.floors.contains(&key), EActionNoPriceFloor);
    let f = policy.floors.get(&key);
    let required = ((amount_in as u256) * f.num + f.den - 1) / f.den;
    let agent_min = eip712::ai_min_amount_out(&a);
    let min_out = to_u64(if (agent_min > required) agent_min else required);
    debit_all(self, &a, clock);

    let input = take_available<In>(self, amount_in);
    emit_authorized(self, &a, amount_in, min_out);
    ActionTicket {
        account: object::id(self),
        action_hash,
        adapter_id: *eip712::ai_adapter_id(&a),
        asset_out,
        amount_in,
        min_out,
        input: option::some(input),
    }
}

/// Only the adapter owning witness `W` can take the input out of its ticket.
public fun take_input<W: drop, In>(ticket: &mut ActionTicket<W, In>, _w: W): Balance<In> {
    assert!(ticket.input.is_some(), ETicketInputAlreadyTaken);
    ticket.input.extract()
}

/// Consumes the ticket. Output and any unspent input go back into the vault; the core measures
/// the output it actually received and enforces the effective minimum itself.
public fun settle<W: drop, In, Out>(self: &mut Account, ticket: ActionTicket<W, In>, _w: W, output: Balance<Out>, leftover: Balance<In>) {
    let ActionTicket { account, action_hash, adapter_id: _, asset_out, amount_in, min_out, input } = ticket;
    assert!(account == object::id(self), ETicketWrongAccount);
    assert!(asset_id<Out>() == asset_out, EActionAssetNotAllowed);
    let refunded = leftover.value();
    assert!(refunded <= amount_in, EActionOverspent);
    let amount_out = output.value();
    assert!(amount_out >= min_out, EActionBelowMinOut);
    if (input.is_some()) deposit_balance(self, input.destroy_some()) else input.destroy_none();
    deposit_balance(self, output);
    deposit_balance(self, leftover);
    event::emit(ActionSettled { object: object::id(self), action_hash, amount_out, refunded });
}

/// Core-native PAY: the recipient is a pinned member of the lease and root policy, and the core
/// transfers to it directly, so delivery is exact by construction.
public fun pay<In>(self: &mut Account, a: ActionIntent, sig: vector<u8>, clock: &Clock, ctx: &mut TxContext) {
    let out = pay_checked<In>(self, &a, &sig, clock, false);
    transfer::public_transfer(coin::from_balance(out, ctx), address::from_bytes(*eip712::ai_recipient(&a)));
}

/// PAY out of the reservation made for `intent`, exactly as the arrival's DestSpec committed.
public fun pay_reserved<In>(self: &mut Account, intent: vector<u8>, a: ActionIntent, sig: vector<u8>, clock: &Clock, ctx: &mut TxContext) {
    claim_reservation(self, &intent, &a, clock);
    let out = pay_checked<In>(self, &a, &sig, clock, true);
    transfer::public_transfer(coin::from_balance(out, ctx), address::from_bytes(*eip712::ai_recipient(&a)));
}

fun pay_checked<In>(self: &mut Account, a: &ActionIntent, sig: &vector<u8>, clock: &Clock, reserved: bool): Balance<In> {
    assert!(eip712::ai_action_kind(a) == KIND_PAY, EActionKindNotAllowed);
    let (_, amount_in) = verify<TransferPayV1, In>(self, a, sig, clock);
    assert!(eip712::ai_asset_out(a) == eip712::ai_asset_in(a), EActionAssetNotAllowed);
    check_pinned_recipient(self, a);
    debit_all(self, a, clock);
    emit_authorized(self, a, amount_in, amount_in);
    if (reserved) take_from_vault<In>(self, amount_in) else take_available<In>(self, amount_in)
}

// ---------------------------------------------------------------- cross-chain

public fun dest_spec(
    action_kind: u8,
    adapter_id: vector<u8>,
    recipient: vector<u8>,
    recipient_label: vector<u8>,
    asset: vector<u8>,
    min_arrival: u256,
    deadline: u64,
): DestSpec {
    DestSpec { action_kind, adapter_id, recipient, recipient_label, asset, min_arrival, deadline }
}

/// keccak256(abi.encode(TAG, kind, adapterId, recipient, keccak(label), asset, minArrival, deadline)).
public fun hash_dest_spec(d: &DestSpec): vector<u8> {
    let mut buf = keccak256(&DEST_SPEC_TAG_PREIMAGE);
    buf.append(eip712::word_u256(d.action_kind as u256));
    buf.append(d.adapter_id);
    buf.append(d.recipient);
    buf.append(keccak256(&d.recipient_label));
    buf.append(d.asset);
    buf.append(eip712::word_u256(d.min_arrival));
    buf.append(eip712::word_u256(d.deadline as u256));
    keccak256(&buf)
}

/// BRIDGE to a destination endpoint pinned in both lease and root policy. `plan_hash` is the
/// agent's commitment to what may happen on arrival (the destination's DestSpec hash).
public fun authorize_bridge<W: drop, In>(self: &mut Account, a: ActionIntent, sig: vector<u8>, clock: &Clock): BridgeTicket<W, In> {
    let input = bridge_checked<W, In>(self, &a, &sig, clock, false);
    bridge_ticket(self, &a, input)
}

/// The return leg of a round trip: BRIDGE out of a reservation whose DestSpec was a BRIDGE.
/// Its own `plan_hash` commits to the next destination, so it is not required to equal `intent`.
public fun authorize_bridge_reserved<W: drop, In>(self: &mut Account, intent: vector<u8>, a: ActionIntent, sig: vector<u8>, clock: &Clock): BridgeTicket<W, In> {
    claim_reservation(self, &intent, &a, clock);
    let input = bridge_checked<W, In>(self, &a, &sig, clock, true);
    bridge_ticket(self, &a, input)
}

public fun take_bridge_input<W: drop, In>(ticket: &mut BridgeTicket<W, In>, _w: W): Balance<In> {
    assert!(ticket.input.is_some(), ETicketInputAlreadyTaken);
    ticket.input.extract()
}

/// The exact bytes the transport must carry: EIP-712 digest of the source intent, then the
/// destination endpoint. The destination core checks both.
public fun bridge_payload<W, In>(ticket: &BridgeTicket<W, In>): vector<u8> {
    let mut p = ticket.intent;
    p.append(ticket.recipient);
    p
}

public fun bridge_amount<W, In>(ticket: &BridgeTicket<W, In>): u64 { ticket.amount }

public fun settle_bridge<W: drop, In>(ticket: BridgeTicket<W, In>, _w: W) {
    let BridgeTicket { account, intent, recipient, amount, input } = ticket;
    assert!(input.is_none(), EActionOverspent);
    input.destroy_none();
    event::emit(BridgeSent { object: account, intent, recipient, amount });
}

/// Called by the transport adapter owning `W` with the funds it redeemed and the intent its
/// payload carried. Everything the source committed to is re-checked here, on arrival.
public fun receive_cross_chain<W: drop, T>(
    self: &mut Account,
    src: ActionIntent,
    src_sig: vector<u8>,
    dest: DestSpec,
    transport_name: vector<u8>,
    transport_version: u32,
    arrived: Balance<T>,
    payload_intent: vector<u8>,
    _w: W,
    clock: &Clock,
) {
    assert!(!self.paused, EActionPaused);
    let lease_id = *eip712::ai_lease_id(&src);
    assert!(self.leases.contains(lease_id), ELeaseNotActive);
    let lease = self.leases[lease_id];
    assert!(lease.status == LEASE_ACTIVE, ELeaseNotActive);
    let now = now_seconds(clock);
    assert!(now <= lease.expires_at && now <= dest.deadline, EXchainExpired);
    let intent = check_source<W>(self, &src, &src_sig, &dest, &transport_name, transport_version, &lease);

    // The destination use must already be allowed here: action kind, adapter, asset, recipient.
    let policy = *self.policy.borrow();
    let kind = dest.action_kind;
    assert!(kind < 32 && (lease.allowed_actions >> kind) & 1 == 1 && (policy.allowed_actions >> kind) & 1 == 1, EActionKindNotAllowed);
    assert!(lease.adapters.contains(&dest.adapter_id) && policy.adapters.contains(&dest.adapter_id), EActionAdapterNotAllowed);
    assert!(dest.asset == asset_id<T>() && lease.assets.contains(&dest.asset), EXchainWrongAsset);
    if (kind == KIND_PAY || kind == KIND_BRIDGE) {
        assert!(lease.recipients.contains(&dest.recipient), EActionRecipientNotAllowed);
        assert!(policy.recipients.contains(&dest.recipient), EActionRecipientNotAllowed);
        assert!(policy.recipients.get(&dest.recipient) == &keccak256(&dest.recipient_label), EActionRecipientNotAllowed);
    } else {
        assert!(dest.recipient == zero32(), EActionRecipientNotAllowed);
    };

    assert!(payload_intent == intent, EXchainPayloadMismatch);
    let amount = arrived.value();
    assert!(amount > 0 && (amount as u256) >= dest.min_arrival, EXchainBelowMinimum);
    deposit_balance(self, arrived);
    self.reservations.add(intent, Reservation {
        lease_id, action_kind: kind, adapter_id: dest.adapter_id, recipient: dest.recipient, asset: dest.asset, deadline: dest.deadline, remaining: amount,
    });
    add_counter(&mut self.reserved, dest.asset, amount);
    event::emit(CrossChainReserved { object: object::id(self), intent, lease_id, asset_id: dest.asset, amount });
}

/// Destination-failure path: once the committed destination can no longer run (deadline passed,
/// lease expired or revoked) the arrival is still redeemed, but straight into quarantine. Before
/// that it is refused, so it cannot divert a deliverable arrival from its reservation.
public fun recover_arrival<W: drop, T>(
    self: &mut Account,
    src: ActionIntent,
    src_sig: vector<u8>,
    dest: DestSpec,
    transport_name: vector<u8>,
    transport_version: u32,
    arrived: Balance<T>,
    payload_intent: vector<u8>,
    _w: W,
    clock: &Clock,
) {
    let lease_id = *eip712::ai_lease_id(&src);
    assert!(self.leases.contains(lease_id), ELeaseNotActive);
    let lease = self.leases[lease_id];
    let now = now_seconds(clock);
    assert!(lease.status != LEASE_ACTIVE || now > lease.expires_at || now > dest.deadline, EXchainNoReservation);
    let intent = check_source<W>(self, &src, &src_sig, &dest, &transport_name, transport_version, &lease);
    assert!(payload_intent == intent, EXchainPayloadMismatch);
    let asset = asset_id<T>();
    let amount = arrived.value();
    assert!(amount > 0, EXchainBelowMinimum);
    deposit_balance(self, arrived);
    add_counter(&mut self.reserved, asset, amount);
    add_counter(&mut self.quarantined, asset, amount);
    event::emit(CrossChainQuarantined { object: object::id(self), intent, asset_id: asset, amount });
}

/// After its deadline an unspent reservation moves to quarantine, never to ordinary spending.
public fun release_reservation(self: &mut Account, intent: vector<u8>, clock: &Clock) {
    assert!(self.reservations.contains(intent), EXchainNoReservation);
    let r = self.reservations[intent];
    assert!(r.remaining > 0 && now_seconds(clock) > r.deadline, EXchainNoReservation);
    self.reservations.remove(intent);
    add_counter(&mut self.quarantined, r.asset, r.remaining);
    event::emit(CrossChainQuarantined { object: object::id(self), intent, asset_id: r.asset, amount: r.remaining });
}

// ---------------------------------------------------------------- views

public fun object_bytes(self: &Account): vector<u8> { self32(self) }
public fun core_version(): u64 { CORE_VERSION }
public fun intent_used(self: &Account, intent: vector<u8>): bool { self.intents_used.contains(intent) }
public fun reserved_of<T>(self: &Account): u64 { counter(&self.reserved, &asset_id<T>()) }
public fun quarantined_of<T>(self: &Account): u64 { counter(&self.quarantined, &asset_id<T>()) }

/// (exists, remaining, deadline) of the reservation made for `intent`.
public fun reservation(self: &Account, intent: vector<u8>): (bool, u64, u64) {
    if (self.reservations.contains(intent)) {
        let r = self.reservations[intent];
        (true, r.remaining, r.deadline)
    } else (false, 0, 0)
}
public fun account_id(self: &Account): vector<u8> { self.account_id }
public fun chain_ref(self: &Account): vector<u8> { self.chain_ref }
public fun controllers(self: &Account): vector<vector<u8>> { self.controllers }
public fun is_paused(self: &Account): bool { self.paused }
public fun pause_epoch(self: &Account): u64 { self.pause_epoch }
public fun last_pause_id(self: &Account): vector<u8> { self.last_pause_id }
public fun op_nonce(self: &Account): u64 { self.op_nonce }

public fun policy_version(self: &Account): u64 {
    if (self.policy.is_some()) self.policy.borrow().version else 0
}

public fun policy_hash(self: &Account): vector<u8> {
    if (self.policy.is_some()) self.policy.borrow().hash else vector[]
}

public fun lease_status(self: &Account, lease_id: vector<u8>): u8 {
    if (self.leases.contains(lease_id)) self.leases[lease_id].status else 0
}

public fun nonce_used(self: &Account, lease_id: vector<u8>, nonce: u64): bool {
    self.nonces.contains(nonce_key(&lease_id, nonce))
}

public fun vault_balance<T>(self: &Account): u64 {
    let k = type_name::with_defining_ids<T>();
    if (self.vault.contains(k)) self.vault.borrow<_, Balance<T>>(k).value() else 0
}

/// (initialized, updated_at, bucket level at update, spent total) for a lease budget.
public fun lease_spend(self: &Account, lease_id: vector<u8>, asset: vector<u8>): (bool, u64, u256, u256) {
    let k = spend_key(b"L", lease_id, asset);
    if (self.spend.contains(k)) {
        let s = self.spend[k];
        (true, s.updated_at, s.level, s.total_spent)
    } else (false, 0, 0, 0)
}

public fun asset_id<T>(): vector<u8> {
    keccak256(type_name::with_defining_ids<T>().into_string().as_bytes())
}

/// Adapter identity on Sui commits to the witness type, whose name embeds the adapter package ID.
/// Adapter packages must be published immutable, otherwise an upgrade keeps the same type name.
public fun adapter_id<W>(chain_ref: &vector<u8>, action_kind: u8, adapter_version: u32, adapter_name: &vector<u8>): vector<u8> {
    let mut buf = keccak256(&ADAPTER_TAG_PREIMAGE);
    buf.append(*chain_ref);
    buf.append(eip712::word_u256(action_kind as u256));
    buf.append(eip712::word_u256(adapter_version as u256));
    buf.append(keccak256(adapter_name));
    buf.append(keccak256(type_name::with_defining_ids<W>().into_string().as_bytes()));
    keccak256(&buf)
}

// ---------------------------------------------------------------- internals

fun verify<W, In>(self: &mut Account, a: &ActionIntent, sig: &vector<u8>, clock: &Clock): (vector<u8>, u64) {
    assert!(!self.paused, EActionPaused);
    assert!(eip712::ai_account_id(a) == &self.account_id, EPolicyWrongAccount);
    assert!(eip712::ai_chain_ref(a) == &self.chain_ref && eip712::ai_account(a) == &self32(self), EActionWrongEndpoint);
    let lease_id = *eip712::ai_lease_id(a);
    assert!(self.leases.contains(lease_id), ELeaseNotActive);
    let lease = self.leases[lease_id];
    assert!(lease.status == LEASE_ACTIVE, ELeaseNotActive);
    let v = policy_version(self);
    assert!(eip712::ai_policy_version(a) == v && lease.policy_version == v, EPolicyVersionMismatch);
    let now = now_seconds(clock);
    assert!(now >= lease.valid_after, ELeaseNotYetValid);
    assert!(now <= lease.expires_at, ELeaseExpired);
    assert!(now <= eip712::ai_deadline(a), EActionExpired);

    let action_hash = eip712::hash_action_intent(a);
    assert!(eip712::recover_signer(action_hash, sig) == lease.agent, EActionWrongAgent);
    let nk = nonce_key(&lease_id, eip712::ai_nonce(a));
    assert!(!self.nonces.contains(nk), EActionNonceReplay);
    self.nonces.add(nk, true);

    let kind = eip712::ai_action_kind(a);
    let policy = *self.policy.borrow();
    assert!(kind < 32 && (lease.allowed_actions >> kind) & 1 == 1 && (policy.allowed_actions >> kind) & 1 == 1, EActionKindNotAllowed);

    let adapter = *eip712::ai_adapter_id(a);
    assert!(lease.adapters.contains(&adapter), EActionAdapterNotAllowed);
    assert!(policy.adapters.contains(&adapter), EActionAdapterNotAllowed);
    let ap = policy.adapters.get(&adapter);
    assert!(ap.name_hash == keccak256(eip712::ai_adapter_name(a)) && ap.version == eip712::ai_adapter_version(a), EActionAdapterNameMismatch);
    let derived = adapter_id<W>(&self.chain_ref, kind, eip712::ai_adapter_version(a), eip712::ai_adapter_name(a));
    assert!(derived == adapter, EActionAdapterWitnessMismatch);

    let asset_in = *eip712::ai_asset_in(a);
    assert!(asset_id<In>() == asset_in, EActionAssetNotAllowed);
    assert!(lease.assets.contains(&asset_in), EActionAssetNotAllowed);
    let amount = eip712::ai_amount_in(a);
    assert!(amount > 0, EActionZeroAmount);
    (action_hash, to_u64(amount))
}

/// Debits lease, root and issuer budgets. Called only after every authorization check has passed,
/// so a rejection names the real reason; the transaction aborts either way.
fun debit_all(self: &mut Account, a: &ActionIntent, clock: &Clock) {
    let lease_id = *eip712::ai_lease_id(a);
    let lease = self.leases[lease_id];
    let policy = *self.policy.borrow();
    let v = policy.version;
    let now = now_seconds(clock);
    let asset_in = *eip712::ai_asset_in(a);
    let amount = eip712::ai_amount_in(a);
    let period = policy.epoch_seconds;
    debit(self, spend_key(b"L", lease_id, asset_in), *lease.assets.get(&asset_in), amount, now, period);
    debit(self, spend_key(b"R", bcs::to_bytes(&v), asset_in), *policy.assets.get(&asset_in), amount, now, period);
    if (!lease.by_controller) {
        let mut k = bcs::to_bytes(&v);
        k.append(lease.issuer);
        debit(self, spend_key(b"I", k, asset_in), issuer_limit(&policy, &lease.issuer, &asset_in), amount, now, period);
    };
}

fun debit(self: &mut Account, key: vector<u8>, lim: Limit, amount: u256, now: u64, period: u64) {
    assert!(amount <= lim.per_action, EBudgetPerAction);
    let (level, total) = if (self.spend.contains(key)) {
        let s = self.spend[key];
        let elapsed = (now - s.updated_at) as u256;
        let p = period as u256;
        let level = if (elapsed >= p) lim.per_epoch
        else {
            // elapsed < period, so neither product can overflow even for caps near 2^256.
            let refill = (lim.per_epoch / p) * elapsed + (lim.per_epoch % p) * elapsed / p;
            if (refill >= lim.per_epoch - s.level) lim.per_epoch else s.level + refill
        };
        (level, s.total_spent)
    } else (lim.per_epoch, 0);
    assert!(amount <= level, EBudgetEpoch);
    let t = total + amount;
    assert!(t <= lim.total, EBudgetTotal);
    let next = Spend { updated_at: now, level: level - amount, total_spent: t };
    if (self.spend.contains(key)) *self.spend.borrow_mut(key) = next else self.spend.add(key, next);
}

fun emit_authorized(self: &Account, a: &ActionIntent, amount_in: u64, min_out: u64) {
    event::emit(ActionAuthorized {
        object: object::id(self),
        lease_id: *eip712::ai_lease_id(a),
        nonce: eip712::ai_nonce(a),
        action_kind: eip712::ai_action_kind(a),
        adapter_id: *eip712::ai_adapter_id(a),
        amount_in,
        min_out,
        plan_hash: *eip712::ai_plan_hash(a),
        plan_step: eip712::ai_plan_step(a),
    });
}

fun check_pinned_recipient(self: &Account, a: &ActionIntent) {
    let recipient = *eip712::ai_recipient(a);
    let lease = self.leases[*eip712::ai_lease_id(a)];
    assert!(lease.recipients.contains(&recipient), EActionRecipientNotAllowed);
    let policy = self.policy.borrow();
    assert!(policy.recipients.contains(&recipient), EActionRecipientNotAllowed);
    assert!(policy.recipients.get(&recipient) == &keccak256(eip712::ai_recipient_label(a)), EActionRecipientNotAllowed);
}

fun bridge_checked<W, In>(self: &mut Account, a: &ActionIntent, sig: &vector<u8>, clock: &Clock, reserved: bool): Balance<In> {
    assert!(eip712::ai_action_kind(a) == KIND_BRIDGE, EActionKindNotAllowed);
    let (_, amount_in) = verify<W, In>(self, a, sig, clock);
    check_pinned_recipient(self, a);
    debit_all(self, a, clock);
    emit_authorized(self, a, amount_in, 0);
    if (reserved) take_from_vault<In>(self, amount_in) else take_available<In>(self, amount_in)
}

fun bridge_ticket<W, In>(self: &Account, a: &ActionIntent, input: Balance<In>): BridgeTicket<W, In> {
    BridgeTicket {
        account: object::id(self),
        intent: eip712::digest(eip712::hash_action_intent(a)),
        recipient: *eip712::ai_recipient(a),
        amount: input.value(),
        input: option::some(input),
    }
}

/// Source-side commitments shared by the reserve and recovery paths: the intent is a BRIDGE to
/// this endpoint, signed by the lease's agent, committing to exactly `dest`, used once, and
/// delivered through the transport adapter `W` allowed here.
fun check_source<W>(self: &mut Account, src: &ActionIntent, src_sig: &vector<u8>, dest: &DestSpec, transport_name: &vector<u8>, transport_version: u32, lease: &Lease): vector<u8> {
    assert!(eip712::ai_account_id(src) == &self.account_id, EPolicyWrongAccount);
    assert!(eip712::ai_action_kind(src) == KIND_BRIDGE, EXchainNotABridgeAction);
    assert!(eip712::ai_recipient(src) == &self32(self), EXchainWrongDestination);
    let intent = eip712::digest(eip712::hash_action_intent(src));
    assert!(!lease.agent.is_empty() && eip712::recover_signer(eip712::hash_action_intent(src), src_sig) == lease.agent, EActionWrongAgent);
    assert!(eip712::ai_plan_hash(src) == &hash_dest_spec(dest), EXchainSpecMismatch);
    assert!(!self.intents_used.contains(intent), EXchainIntentUsed);
    self.intents_used.add(intent, true);
    let policy = self.policy.borrow();
    let transport = adapter_id<W>(&self.chain_ref, KIND_BRIDGE, transport_version, transport_name);
    assert!(lease.adapters.contains(&transport) && policy.adapters.contains(&transport), EActionAdapterNotAllowed);
    let ap = policy.adapters.get(&transport);
    assert!(ap.name_hash == keccak256(transport_name) && ap.version == transport_version, EActionAdapterNameMismatch);
    intent
}

/// Matches an action against the reservation made for `intent` and consumes that much of it.
fun claim_reservation(self: &mut Account, intent: &vector<u8>, a: &ActionIntent, clock: &Clock) {
    assert!(self.reservations.contains(*intent), EXchainNoReservation);
    let r = self.reservations[*intent];
    assert!(r.remaining > 0, EXchainNoReservation);
    assert!(now_seconds(clock) <= r.deadline, EXchainExpired);
    let kind = eip712::ai_action_kind(a);
    let amount = eip712::ai_amount_in(a);
    assert!(
        eip712::ai_lease_id(a) == &r.lease_id && (eip712::ai_plan_hash(a) == intent || r.action_kind == KIND_BRIDGE) && kind == r.action_kind
            && eip712::ai_adapter_id(a) == &r.adapter_id && eip712::ai_recipient(a) == &r.recipient && eip712::ai_asset_in(a) == &r.asset
            && amount <= (r.remaining as u256),
        EXchainReservationMismatch,
    );
    let amount = amount as u64;
    self.reservations.borrow_mut(*intent).remaining = r.remaining - amount;
    sub_counter(&mut self.reserved, r.asset, amount);
}

/// Ordinary actions draw only on what is neither reserved nor quarantined.
fun take_available<T>(self: &mut Account, amount: u64): Balance<T> {
    let locked = counter(&self.reserved, &asset_id<T>());
    let bal = vault_balance<T>(self);
    assert!(bal >= locked && bal - locked >= amount, EXchainReservedFunds);
    take_from_vault<T>(self, amount)
}

fun counter(t: &Table<vector<u8>, u64>, k: &vector<u8>): u64 { if (t.contains(*k)) t[*k] else 0 }

fun add_counter(t: &mut Table<vector<u8>, u64>, k: vector<u8>, x: u64) {
    if (t.contains(k)) { let v = t.borrow_mut(k); *v = *v + x } else t.add(k, x)
}

fun sub_counter(t: &mut Table<vector<u8>, u64>, k: vector<u8>, x: u64) {
    if (x == 0) return;
    let v = t.borrow_mut(k);
    *v = *v - x;
}

fun issuer_limit(policy: &StoredPolicy, issuer: &vector<u8>, asset: &vector<u8>): Limit {
    let ip = policy.issuers.get(issuer);
    if (ip.limits.contains(asset)) *ip.limits.get(asset) else Limit { per_action: 0, per_epoch: 0, total: 0 }
}

fun require_threshold(self: &Account, struct_hash: vector<u8>, sigs: &vector<vector<u8>>) {
    let mut last = vector[];
    let mut count = 0u64;
    sigs.do_ref!(|sig| {
        let s = eip712::recover_signer(struct_hash, sig);
        assert!(last.is_empty() || lt_bytes(&last, &s), EControllerUnsorted);
        assert!(self.controllers.contains(&s), EControllerNotAuthorized);
        last = s;
        count = count + 1;
    });
    assert!(count >= (self.threshold as u64), EControllerThreshold);
}

fun deposit_balance<T>(self: &mut Account, b: Balance<T>) {
    let k = type_name::with_defining_ids<T>();
    if (self.vault.contains(k)) {
        self.vault.borrow_mut<_, Balance<T>>(k).join(b);
    } else if (b.value() > 0) {
        self.vault.add(k, b);
    } else {
        b.destroy_zero();
    }
}

fun take_from_vault<T>(self: &mut Account, amount: u64): Balance<T> {
    let k = type_name::with_defining_ids<T>();
    assert!(self.vault.contains(k), EInsufficientVault);
    let bal = self.vault.borrow_mut<_, Balance<T>>(k);
    assert!(bal.value() >= amount, EInsufficientVault);
    bal.split(amount)
}

fun label_map(xs: &vector<eip712::Recipient>): VecMap<vector<u8>, vector<u8>> {
    let mut m = vec_map::empty();
    xs.do_ref!(|r| {
        let (id, label) = eip712::recipient_fields(r);
        assert!(!m.contains(&id), EPolicyDuplicateEntry);
        m.insert(id, keccak256(&label));
    });
    m
}

fun assert_unique(xs: &vector<vector<u8>>) {
    let n = xs.length();
    let mut i = 0;
    while (i < n) {
        let mut j = i + 1;
        while (j < n) {
            assert!(xs[i] != xs[j], ELeaseDuplicateEntry);
            j = j + 1;
        };
        i = i + 1;
    }
}

fun revoked_placeholder(): Lease {
    Lease {
        status: LEASE_REVOKED,
        by_controller: false,
        policy_version: 0,
        agent: vector[],
        issuer: vector[],
        valid_after: 0,
        expires_at: 0,
        allowed_actions: 0,
        adapters: vector[],
        assets: vec_map::empty(),
        recipients: vector[],
        beneficiaries: vector[],
    }
}

fun self32(self: &Account): vector<u8> { object::uid_to_bytes(&self.id) }

fun zero32(): vector<u8> {
    let mut z = vector[];
    let mut i = 0u64;
    while (i < 32) {
        z.push_back(0);
        i = i + 1;
    };
    z
}

fun pair_key(a: &vector<u8>, b: &vector<u8>): vector<u8> {
    let mut k = *a;
    k.append(*b);
    k
}

fun nonce_key(lease_id: &vector<u8>, nonce: u64): vector<u8> {
    let mut k = *lease_id;
    k.append(bcs::to_bytes(&nonce));
    k
}

fun spend_key(tag: vector<u8>, scope: vector<u8>, asset: vector<u8>): vector<u8> {
    let mut k = tag;
    k.append(scope);
    k.append(asset);
    k
}

fun now_seconds(clock: &Clock): u64 { clock.timestamp_ms() / 1000 }

fun to_u64(x: u256): u64 {
    assert!(x <= 0xffffffffffffffffu256, EActionAmountTooLarge);
    x as u64
}

fun lt_bytes(a: &vector<u8>, b: &vector<u8>): bool {
    let n = a.length();
    let mut i = 0;
    while (i < n) {
        if (a[i] < b[i]) return true;
        if (a[i] > b[i]) return false;
        i = i + 1;
    };
    false
}

#[test_only]
public fun take_input_for_testing<W: drop, In>(ticket: &mut ActionTicket<W, In>, w: W): Balance<In> { take_input(ticket, w) }
