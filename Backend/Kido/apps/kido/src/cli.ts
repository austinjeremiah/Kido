#!/usr/bin/env -S npx tsx
import { pathToFileURL } from "node:url";
import { createFoundry, loadConfig } from "./config.js";

const USAGE = `kido <command> [args]
  create "<objective>"              start a project; prints its id and first question
  next <project>                    the next question
  answer <project> "<text>"         answer the pending question
  edit <project> <key> "<text>"     change an answered requirement
  unresolved <project>              requirements still open
  blueprint <project>               current blueprint revision
  finalize <project>                compile a new blueprint revision
  security-review <project>         run the deterministic security review
  simulate <project>                run the simulation scenarios
  build <project>                   build (only when every gate passes)
  status <project>                  lifecycle status
  registry                          providers and their status
  drift                             knowledge drift report`;

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export async function runCli(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const [cmd, ...a] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") return out(USAGE), 0;
  const foundry = createFoundry(loadConfig());
  const need = (n: number) => {
    if (a.length < n) throw new Error(`usage: ${USAGE.split("\n").find((l) => l.trim().startsWith(cmd)) ?? cmd}`);
  };
  const run: Record<string, () => unknown> = {
    create: () => (need(1), foundry.create(a.join(" "))),
    next: () => (need(1), { question: foundry.next(a[0]!) }),
    answer: () => (need(2), foundry.answer(a[0]!, a.slice(1).join(" "))),
    edit: () => (need(3), foundry.edit(a[0]!, a[1]!, a.slice(2).join(" "))),
    unresolved: () => (need(1), { unresolved: foundry.unresolved(a[0]!) }),
    blueprint: () => (need(1), { blueprint: foundry.blueprint(a[0]!) }),
    finalize: () => (need(1), foundry.finalize(a[0]!)),
    "security-review": () => (need(1), foundry.securityReview(a[0]!)),
    simulate: () => (need(1), foundry.simulate(a[0]!)),
    build: () => (need(1), foundry.build(a[0]!)),
    status: () => (need(1), foundry.status(a[0]!)),
    registry: () => foundry.registry.providers.map((m) => ({ providerId: m.providerId, kind: m.kind, chains: m.chains, status: m.status })),
    drift: () => ({ drift: foundry.knowledge.drift(foundry.registry), quarantined: foundry.knowledge.quarantined }),
  };
  const f = run[cmd];
  if (!f) return out(USAGE), 2;
  try {
    out(JSON.stringify(await f(), replacer, 2));
    return 0;
  } catch (err) {
    out(JSON.stringify({ error: (err as { code?: string }).code ?? "KIDO_CLI_ERROR", message: (err as Error).message }, null, 2));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2));
