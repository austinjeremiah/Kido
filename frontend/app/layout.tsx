import type { Metadata } from 'next';
import { IBM_Plex_Mono } from 'next/font/google';

/*
 * The one typeface the project did not have.
 *
 * Every label, badge, count, threshold and address in the workbench used to be
 * set in the UI sans at 10–11px, uppercase and letterspaced — which is the
 * house style of every admin template ever shipped. A real mono under the micro
 * type separates the instrument readings from the prose around them, and gives
 * the numbers tabular widths so a column of dollar limits lines up on the
 * decimal instead of drifting.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--kd-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Kido — Give AI authority, not keys',
  description:
    'Design, prove, deploy and operate secure financial agents. Authority is bounded by a deterministic policy layer, not by a prompt.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    /*
     * suppressHydrationWarning on <html> and <body> only.
     *
     * Wallet extensions (Leather, MetaMask, Phantom) inject provider scripts as
     * direct children of <body> before React hydrates, which React reports as a
     * hydration mismatch it cannot attribute to anything in this codebase. The
     * flag suppresses the warning one level deep — it does not extend into the
     * app tree, so genuine mismatches inside the workbench are still reported.
     */
    <html lang="en" className="w-mod-js" suppressHydrationWarning>
      <body className={`body ${plexMono.variable}`} suppressHydrationWarning>
        {/* Same cascade order as the original: Webflow base, Lenis, then the
            custom Three.js app styles. Served verbatim from /public. */}
        <link rel="stylesheet" href="/styles/webflow.css" precedence="high" />
        <link rel="stylesheet" href="/styles/lenis.css" precedence="high" />
        <link rel="stylesheet" href="/styles/app.css" precedence="high" />
        <link rel="stylesheet" href="/styles/inline.css" precedence="high" />
        {/* Kido's own additions load last so they win on equal
            specificity without !important. Kept separate from the scraped
            Webflow sheets above. */}
        <link rel="stylesheet" href="/styles/landing.css" precedence="high" />
        {/*
          No wallet providers here, deliberately. WalletProvider swaps its own
          element type when a session activates, which remounts everything below
          it — and the landing's Three.js engine cannot survive its canvas being
          destroyed. The wallet lives in app/projects/layout instead.
        */}
        {children}
      </body>
    </html>
  );
}
