# StudioMeyer Ecosystem

Darwin Agents is part of the StudioMeyer open source toolkit. Here is everything we build and maintain.

## MCP Server Products (Hosted)

| Product | Tools | What it does | Link |
|---------|-------|-------------|------|
| **StudioMeyer Memory** | 53 | Persistent AI memory with knowledge graph, semantic search, multi-agent support | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| **StudioMeyer CRM** | 33 | Headless CRM — contacts, companies, deals, pipeline, health scores, Stripe sync | [crm.studiomeyer.io](https://crm.studiomeyer.io) |
| **StudioMeyer GEO** | 24 | AI visibility monitoring across 8 LLM platforms | [geo.studiomeyer.io](https://geo.studiomeyer.io) |
| **MCP Crew** | 10 | 8 expert personas with domain frameworks | [crew.studiomeyer.io](https://crew.studiomeyer.io) |

All MCP products use OAuth 2.1 + Magic Link authentication. Free tiers available. EU Frankfurt hosting.

## Open Source Tools

| Project | Description | Install |
|---------|-------------|---------|
| **[AI Shield](https://github.com/studiomeyer-io/ai-shield)** | LLM security — prompt injection, PII, cost tracking, tool policies | `npm install ai-shield-core` |
| **[Darwin Agents](https://github.com/studiomeyer-io/darwin-agents)** | Self-evolving AI agents with A/B testing and safety gates | `npm install darwin-agents` |
| **[Agent Fleet](https://github.com/studiomeyer-io/agent-fleet)** | Multi-agent orchestration for Claude Code CLI | `git clone` + `npm install` |
| **[MCP Video](https://github.com/studiomeyer-io/mcp-video)** | Cinema-grade video production via MCP | `npx mcp-video` |

## How Darwin fits in

Darwin powers the self-evolution layer. The MCP server products above use Darwin internally to optimize their agent prompts over time. You can use Darwin standalone for your own agents, or combine it with Agent Fleet for a full multi-agent setup with automatic improvement.

Typical stack: **Agent Fleet** (orchestration) + **Darwin** (evolution) + **AI Shield** (security) + **StudioMeyer Memory** (persistence).

## License

All open source projects are MIT licensed.

---

Built by [StudioMeyer](https://studiomeyer.io) — AI agency from Mallorca, Spain.
