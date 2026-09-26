import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type KidoEventType =
  | "MONITOR_EVENT"
  | "MONITOR_HEALTH"
  | "GATE_DECISION"
  | "PLAN_COMPILED"
  | "PLAN_REFUSED"
  | "ACTION_SUBMITTED"
  | "ACTION_EXECUTED"
  | "ACTION_REJECTED_BY_AMANE"
  | "ACTION_NONCE_CONSUMED"
  | "ACTION_OPERATIONAL_FAILURE"
  | "REASONING_WOKEN"
  | "RECOVERY_STARTED"
  | "RECOVERY_REQUIRED"
  | "RECOVERY_COMPLETED"
  | "OWNER_NOTIFIED";

export type Severity = "INFO" | "NOTICE" | "WARNING" | "ERROR";

export interface KidoEvent {
  seq: number;
  at: number;
  agentId: string;
  type: KidoEventType;
  severity: Severity;
  planHash?: string | undefined;
  chain?: string | undefined;
  tx?: string | undefined;
  code?: string | undefined;
  /** Public metadata only. Private values never enter the log. */
  data: Record<string, unknown>;
}

export type EventInput = Omit<KidoEvent, "seq" | "at"> & { at?: number };

export interface EventLog {
  append(e: EventInput): KidoEvent;
  list(filter?: Partial<Pick<KidoEvent, "type" | "planHash" | "agentId">>): KidoEvent[];
}

const json = (e: KidoEvent) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export class MemoryEventLog implements EventLog {
  protected readonly events: KidoEvent[] = [];
  constructor(protected readonly clock: () => number = Date.now) {}
  append(e: EventInput): KidoEvent {
    const ev: KidoEvent = { ...e, seq: this.events.length + 1, at: e.at ?? this.clock() };
    this.events.push(JSON.parse(json(ev)) as KidoEvent);
    return ev;
  }
  list(filter: Partial<Pick<KidoEvent, "type" | "planHash" | "agentId">> = {}): KidoEvent[] {
    return this.events.filter((e) => Object.entries(filter).every(([k, v]) => (e as unknown as Record<string, unknown>)[k] === v));
  }
}

/** Append-only JSON-lines log; reloads existing events on construction. */
export class FileEventLog extends MemoryEventLog {
  constructor(readonly path: string, clock: () => number = Date.now) {
    super(clock);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) this.events.push(JSON.parse(line) as KidoEvent);
  }
  override append(e: EventInput): KidoEvent {
    const ev = super.append(e);
    appendFileSync(this.path, json(ev) + "\n");
    return ev;
  }
}
