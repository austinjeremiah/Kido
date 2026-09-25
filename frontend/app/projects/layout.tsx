import type { ReactNode } from 'react';
import { ServerStateProvider } from '@/components/studio/ServerStateProvider';
import { WalletSessionProvider } from '@/lib/studio/wallet-session';
import { WalletProvider } from '@/components/studio/wallet/WalletProvider';

/**
 * The wallet session lives here rather than at the root because WalletProvider
 * changes its own element type when a session activates, remounting everything
 * below it. That is harmless inside the workbench and fatal on the landing,
 * whose Three.js engine holds a direct reference to a canvas that would be
 * destroyed and recreated.
 */
export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="stylesheet" href="/styles/studio.css" precedence="high" />
      <ServerStateProvider>
        <WalletSessionProvider>
          <WalletProvider>{children}</WalletProvider>
        </WalletSessionProvider>
      </ServerStateProvider>
    </>
  );
}
