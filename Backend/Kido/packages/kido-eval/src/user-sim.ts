import { Agent, run, setTracingDisabled } from "@openai/agents";

setTracingDisabled(process.env.KIDO_OPENAI_TRACING !== "1");

const RULES = `
You are role-playing a non-technical user talking to Kido, a service that builds AI agents.
You know only the facts in YOUR SITUATION. Answer the question you are asked in one or two short
sentences, the way a real person would. Reveal only what the question asks for. If the question is
about something your situation does not cover, say you are not sure and would prefer the safest option.
Never invent addresses or amounts that are not in your situation.
`.trim();

export class UserSimulator {
  constructor(private readonly facts: string, private readonly model: string) {}
  async answer(question: string, choices?: { value: string; label: string }[]): Promise<string> {
    const agent = new Agent({ name: "User", model: this.model, instructions: `${RULES}\n\nYOUR SITUATION:\n${this.facts}` });
    const opts = choices?.length ? `\n(Options offered: ${choices.map((c) => c.label).join("; ")})` : "";
    const r = await run(agent, `Kido asks: ${question}${opts}`, { maxTurns: 1 });
    return String(r.finalOutput ?? "").trim();
  }
}
