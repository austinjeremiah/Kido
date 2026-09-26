/// Openly mintable testnet-only demo token. Not a representation of any real asset.
module amane_tokens::amusd;

use sui::coin::{Self, Coin, TreasuryCap};

public struct AMUSD has drop {}

public struct Faucet has key {
    id: UID,
    cap: TreasuryCap<AMUSD>,
}

#[allow(deprecated_usage)]
fun init(witness: AMUSD, ctx: &mut TxContext) {
    let (cap, metadata) = coin::create_currency(
        witness,
        6,
        b"AMUSD",
        b"Amane Test USD",
        b"Testnet-only demo token for Amane. Not a representation of any real asset.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::share_object(Faucet { id: object::new(ctx), cap });
}

public fun mint(faucet: &mut Faucet, amount: u64, ctx: &mut TxContext): Coin<AMUSD> {
    coin::mint(&mut faucet.cap, amount, ctx)
}
