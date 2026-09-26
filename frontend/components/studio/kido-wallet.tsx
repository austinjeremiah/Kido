'use client';

/**
 * Wallet-side steps for Kido deployment and owner controls. Everything the owner authorizes is
 * signed or sent from their own wallet here; the backend only prepares messages and relays Sui.
 * Rendered only inside the wallet runtime (after the owner chooses to connect).
 */
import { useCallback } from 'react';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { reviveTypedData } from '@/lib/kido/typed-data';
import type { TxRequest, TypedDataWire } from '@/lib/kido/types';

export function useOwnerWallet() {
  const { address, chainId, isConnected } = useAccount();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient({ chainId: sepolia.id });
  const { switchChainAsync } = useSwitchChain();

  const sign = useCallback(
    async (td: TypedDataWire) => {
      if (!wallet) throw new Error('Connect a wallet first.');
      return wallet.signTypedData(reviveTypedData(td) as never);
    },
    [wallet],
  );

  /** Sends each transaction from the owner's wallet on Sepolia and waits for it to succeed. */
  const send = useCallback(
    async (txs: TxRequest[], onSent?: (tx: TxRequest, hash: `0x${string}`) => Promise<void> | void) => {
      if (!wallet || !publicClient) throw new Error('Connect a wallet first.');
      const hashes: `0x${string}`[] = [];
      for (const tx of txs) {
        if (chainId !== tx.chainId) await switchChainAsync({ chainId: tx.chainId });
        const hash = await wallet.sendTransaction({ chain: sepolia, account: wallet.account, ...(tx.to ? { to: tx.to } : {}), data: tx.data } as never);
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error(`${tx.label} reverted (${hash})`);
        hashes.push(hash);
        await onSent?.(tx, hash);
      }
      return hashes;
    },
    [wallet, publicClient, chainId, switchChainAsync],
  );

  return { address, isConnected, sign, send, ready: Boolean(wallet && publicClient) };
}
