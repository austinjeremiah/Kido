'use client';

/**
 * The wallet runtime for the landing page, mounted as a SIBLING of the page
 * content rather than a wrapper around it.
 *
 * That placement is the point. A provider that appears when a session activates
 * remounts everything below it, and the Three.js engine holds a direct
 * reference to the hero canvas — the remount destroys the scene. Rendered
 * alongside the page, this mounts without the landing noticing.
 *
 * It reuses the workbench's own WalletRuntime rather than rebuilding the
 * provider stack. A copy here drifted immediately: it missed the RainbowKit
 * stylesheet import, so the modal rendered unstyled and the landing's Webflow
 * rules (img { max-width: 100% }) inflated the wallet icons to full width.
 *
 * The one thing it adds is a QueryClient. The workbench gets one from
 * ServerStateProvider; the landing has none, and wagmi's hooks require it.
 */
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { WalletRuntime } from '@/components/studio/wallet/WalletRuntime';

const queryClient = new QueryClient();

function ConnectFlow({ onConnected }: { onConnected: () => void }) {
  const { openConnectModal } = useConnectModal();
  const { isConnected } = useAccount();

  // The user pressed Get Started to get here; there is nothing else to ask.
  useEffect(() => {
    if (!isConnected) openConnectModal?.();
  }, [openConnectModal, isConnected]);

  useEffect(() => {
    if (isConnected) onConnected();
  }, [isConnected, onConnected]);

  return null;
}

export function LandingWalletRuntime({ onConnected }: { onConnected: () => void }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WalletRuntime>
        <ConnectFlow onConnected={onConnected} />
      </WalletRuntime>
    </QueryClientProvider>
  );
}
