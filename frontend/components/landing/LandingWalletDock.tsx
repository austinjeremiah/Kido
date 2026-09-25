'use client';

/**
 * Gate for the landing's wallet runtime.
 *
 * Renders nothing at all until Get Started is pressed, so a visitor who only
 * reads the page never downloads wagmi or RainbowKit. Once connected it sends
 * them into the Studio with a full page load, which is also what the Three.js
 * engine needs — it cannot re-initialise against a DOM it did not build.
 */
import dynamic from 'next/dynamic';
import { useCallback } from 'react';
import { useWalletSession } from '@/lib/studio/wallet-session';

const LandingWalletRuntime = dynamic(
  () => import('./LandingWalletRuntime').then((m) => m.LandingWalletRuntime),
  { ssr: false, loading: () => null },
);

export function LandingWalletDock() {
  const { activated } = useWalletSession();

  const onConnected = useCallback(() => {
    // Full navigation, not a router push: the Studio needs its own provider
    // tree and wagmi's storage carries the connection across the load.
    window.location.assign('/projects');
  }, []);

  if (!activated) return null;
  return <LandingWalletRuntime onConnected={onConnected} />;
}
