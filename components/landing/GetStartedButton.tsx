'use client';

/**
 * The landing page's only call to action.
 *
 * Pressing it activates the wallet session, which mounts the connect runtime in
 * LandingWalletDock — a sibling of this page's content, not a wrapper around
 * it. The modal opens here on the landing; once a wallet is connected the dock
 * sends the visitor into the Studio.
 */
import { useWalletSession } from '@/lib/studio/wallet-session';

export function GetStartedButton() {
  const { activated, requestConnect } = useWalletSession();

  return (
    <button type="button" className="cl-hero-cta__primary" onClick={requestConnect} disabled={activated}>
      {activated ? 'Connecting…' : 'Get Started'}
    </button>
  );
}
