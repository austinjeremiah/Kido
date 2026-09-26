/// Openly mintable testnet-only demo token. Not a representation of any real asset.
module amane_tokens::amsui;

use sui::coin::{Self, Coin, TreasuryCap};

public struct AMSUI has drop {}

public struct Faucet has key {
    id: UID,
    cap: TreasuryCap<AMSUI>,
}

#[allow(deprecated_usage)]
fun init(witness: AMSUI, ctx: &mut TxContext) {
    let (cap, metadata) = coin::create_currency(
        witness,
        9,
        b"AMSUI",
        b"Amane Test SUI",
        b"Testnet-only demo token for Amane. Not a representation of any real asset.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::share_object(Faucet { id: object::new(ctx), cap });
}

public fun mint(faucet: &mut Faucet, amount: u64, ctx: &mut TxContext): Coin<AMSUI> {
    coin::mint(&mut faucet.cap, amount, ctx)
}
