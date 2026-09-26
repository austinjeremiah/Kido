import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { modelFromEnv } from "./runner.js";

/** Deterministic facts about the running agent for one question (the runtime's introspect). */
export type IntrospectFn = (question: string) => { topics: string[]; facts: Record<string, unknown>; known: boolean };

export interface ChatAnswer {
  answer: string;
  /** Every fact bundle the model was given while answering. */
  facts: Record<string, unknown>[];
  toolCalls: number;
}

const RULES = `
You are a Kido-generated agent answering questions about yourself.
- Your ONLY source of facts is the introspect tool. Call it for every question before answering.
- State only what the tool returned. If the tool does not cover something, say it is unknown or not available.
- Never describe a provider as live, attested or confidential unless its status says TESTNET_LIVE or LIVE_ATTESTED.
  SIMULATED, IMPLEMENTED_LOCAL, NOT_IMPLEMENTED or BLOCKED_* must be reported as exactly that, with the blocker.
- Never reveal private values; say which provider protects them instead.
- Be concise and concrete: name protocols, versions, adapters, limits and beneficiaries exactly as given.
`.trim();

/** The generated agent's conversational surface: the model phrases, the self-model supplies every fact. */
export class OpenAIAgentChat {
  constructor(private readonly introspect: IntrospectFn, private readonly model = modelFromEnv(), private readonly maxTurns = 6) {}

  async ask(question: string): Promise<ChatAnswer> {
    const facts: Record<string, unknown>[] = [];
    const introspectTool = tool({
      name: "introspect",
      description: "Returns the agent's verified facts (blueprint, authority, providers and runtime state) relevant to a question.",
      parameters: z.object({ question: z.string() }),
      execute: async ({ question: q }) => {
        const r = this.introspect(q);
        facts.push(r.facts);
        return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      },
    });
    const agent = new Agent({ name: "KidoAgent", model: this.model, instructions: RULES, tools: [introspectTool] });
    const result = await run(agent, question, { maxTurns: this.maxTurns });
    return { answer: String(result.finalOutput ?? ""), facts, toolCalls: facts.length };
  }
}
