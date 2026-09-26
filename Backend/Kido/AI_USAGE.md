# AI usage

| Tool | Where used |
|---|---|
| Claude Code (Anthropic CLI) | implementation agent, working against a written build specification with test-gated phases |
| OpenAI API | **runtime only**: the optional live model for the design interview, specialist agent chat and the live conversational evaluation. Absent key ⇒ `BLOCKED_ENV`, never a silent mock. |

What AI does **not** decide:

- **Financial authority.** Amane enforces every action on-chain; no model is in the authorization path.
- **Confirmed requirements.** The user's own words are authoritative; a model reading can never
  change a confirmed critical requirement.
- **Provider status.** Registry status records what was proven with evidence, not what a model says.

Specifications, prompts and working notes are kept outside the repository by the project's build
rules; findings and evidence from live runs are recorded there as well.
