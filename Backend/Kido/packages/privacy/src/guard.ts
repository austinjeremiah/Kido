export class PrivacyLeakError extends Error {
  constructor(readonly valueId: string, readonly sink: string) {
    super(`KIDO_PRIVACY_LEAK: private value ${valueId} reached ${sink}`);
    this.name = "PrivacyLeakError";
  }
}

/**
 * Runtime guard for private values (bible §28). Values registered here are scrubbed from any text
 * headed to logs or events, and `assertClean` refuses to let one reach a model context or public
 * record. The guard stores only the values it is given for the lifetime of the process.
 */
export class PrivacyGuard {
  private readonly values = new Map<string, string>();

  register(valueId: string, value: string): void {
    if (value.length < 3) throw new Error("refusing to guard a value shorter than 3 characters (would redact everything)");
    this.values.set(valueId, value);
  }

  redact(text: string): string {
    let out = text;
    for (const [id, v] of this.values) out = out.split(v).join(`[private:${id}]`);
    return out;
  }

  assertClean(text: string, sink: string): void {
    for (const [id, v] of this.values) if (text.includes(v)) throw new PrivacyLeakError(id, sink);
  }

  /** Deep-scans a JSON-able object (audit metadata, identity records, model context). */
  assertCleanObject(obj: unknown, sink: string): void {
    this.assertClean(JSON.stringify(obj) ?? "", sink);
  }

  logger(sink: (line: string) => void): (line: string) => void {
    return (line) => sink(this.redact(line));
  }
}
