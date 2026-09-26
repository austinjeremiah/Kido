import type React from "react";
import { LabApiError } from "../lab-api";

/**
 * The difference between "this project has nothing of that kind" and "something went wrong".
 *
 * Every Lab panel fetches something a project might not have. A project built in this browser has
 * no market snapshot, no recorded shadow run and — until the design step finishes — no compiled
 * Blueprint. All three are normal, and all three arrive as a 404.
 *
 * Rendering them as red errors was worse than unhelpful: it put five red boxes on a working screen
 * and taught the reader that red boxes on this product are noise. An absence gets a plain
 * explanation and a sentence saying what would produce it.
 */
export function PanelProblem({ error, absent }: { error: Error; absent: string }): React.ReactElement {
  const is404 = error instanceof LabApiError && error.isAbsent;
  if (is404) {
    return (
      <p className="empty">
        {absent} <span className="absent-detail">({error.message})</span>
      </p>
    );
  }
  return <p className="error">{error.message}</p>;
}
