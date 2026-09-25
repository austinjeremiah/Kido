import Preloader from '@/components/Preloader';
import PageBody from '@/components/PageBody';
import SiteScripts from '@/components/SiteScripts';
import { WalletSessionProvider } from '@/lib/studio/wallet-session';
import { LandingWalletDock } from '@/components/landing/LandingWalletDock';

/**
 * WalletSessionProvider is safe to wrap the landing: it is always the same
 * element type, so activating a session does not change the tree shape and
 * nothing below it remounts. The runtime that DOES change shape is mounted as a
 * sibling instead — see LandingWalletDock — because a remount would destroy the
 * hero canvas the Three.js engine holds a reference to.
 */
export default function Page() {
  return (
    <WalletSessionProvider>
      <Preloader />
      <PageBody />
      <SiteScripts />
      <LandingWalletDock />
    </WalletSessionProvider>
  );
}
