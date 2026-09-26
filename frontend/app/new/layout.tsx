import type { ReactNode } from 'react';

/**
 * studio.css first, create.css second.
 *
 * The page renders the workbench's own primitives, which live under .cl-studio
 * in studio.css; create.css only adds the frame and the split, and loads last
 * so it wins on equal specificity without restating anything.
 */
export default function CreateLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="stylesheet" href="/styles/studio.css" precedence="high" />
      <link rel="stylesheet" href="/styles/create.css" precedence="high" />
      {children}
    </>
  );
}
