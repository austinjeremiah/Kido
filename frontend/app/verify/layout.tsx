import type { ReactNode } from 'react';

/** The public verify page renders workbench primitives, which live in studio.css. */
export default function VerifyLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="stylesheet" href="/styles/studio.css" precedence="high" />
      {children}
    </>
  );
}
