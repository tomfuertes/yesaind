# AI Cost Analysis - YesAInd

**Project:** YesAInd - multiplayer improv canvas with AI agent integration
**Sprint:** 6-day build, Feb 2026

---

## Development & Testing Costs

### Claude Code (Development Assistant)

The entire project was built using Claude Code as the primary development tool - architecture decisions, implementation, debugging, and refactoring.

**Session breakdown:**

- 231 Claude Code sessions over 6 days
- Mix of models: Opus 4.6 (architecture/planning), Sonnet 4.6 (implementation), Haiku 4.5 (mechanical tasks)
- Avg estimated turns per session: ~35 (implementation sessions run longer; exploration sessions shorter)
- Model mix by session type: ~15% Opus, ~65% Sonnet, ~20% Haiku

**Token cost estimates per session type:**

| Session Type            | Model      | Avg Turns | Est. Cost/Session |
| ----------------------- | ---------- | --------- | ----------------- |
| Architecture / planning | Opus 4.6   | 20        | ~$0.60            |
| Feature implementation  | Sonnet 4.6 | 40        | ~$0.84            |
| Exploration / search    | Sonnet 4.6 | 15        | ~$0.32            |
| Mechanical / rename     | Haiku 4.5  | 25        | ~$0.18            |

**Estimated total Claude Code spend:** ~$180-220

### Prompt Eval Harness (Production AI Testing)

The eval harness runs 35 scenarios x 7 runs each against the actual AI pipeline to score layout quality, overlap, and narrative coherence. This is real AI spend - each scenario turn calls the production model.

- Full eval suite: 35 scenarios x 7 runs x ~$0.015/run (Haiku judge + main response) = ~$3.68/run
- Eval runs during development: ~25 full suite runs
- Diagnostic script runs (prompt-scenarios-diag.ts): ~15 additional diagnostic passes
- **Eval total:** ~$92 + ~$28 = ~$120

### Quality Signal Judge (Per-Turn Haiku Scoring)

Deployed in v26, gated by env var. Each turn fires a secondary Haiku call scoring 4 dimensions (yesAnd, characterConsistency, sceneAdvancement, toolAppropriateness). Added ~$0.002/turn overhead during UAT sessions.

- UAT sessions: ~10 hours x ~5 turns/min x $0.002 = ~$6

### Total Development & Testing Spend

| Category                    | Estimated Cost |
| --------------------------- | -------------- |
| Claude Code (development)   | ~$200          |
| Prompt eval harness         | ~$120          |
| Quality signal UAT overhead | ~$6            |
| **Total**                   | **~$326**      |

_Note: Cloudflare Workers hosting, D1 storage, and Durable Objects are free tier during development. No additional AI hosting costs - all models accessed via Anthropic/OpenAI APIs directly._

---

## Production Cost Projections

### Assumptions

| Parameter                    | Value            | Reasoning                                                                              |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| Default model                | Claude Haiku 4.5 | Tuned to 97% eval score; Sonnet requires v28 prompt work                               |
| AI turns per session         | 3 commands       | Conservative - improv games average 5-10, but many users lurk                          |
| Sessions per user/month      | 2                | Weekly-ish engagement for casual users                                                 |
| **AI calls per turn**        | **3-4**          | Main response + stage manager + reactive persona (quality signal gated off by default) |
| Effective cost per user turn | $0.007           | Haiku at $1/$5 per MTok input/output; ~700 input + 300 output tokens per call          |
| Total AI turns/user/month    | 6                | 3 commands x 2 sessions                                                                |

### Monthly Cost Projections

| Scale  | Users   | AI Turns/Month | Cost @ $0.007/turn | CF Workers\* | D1 Storage\* | **Total/Month** |
| ------ | ------- | -------------- | ------------------ | ------------ | ------------ | --------------- |
| Seed   | 100     | 600            | $4.20              | Free         | Free         | **~$4**         |
| Early  | 1,000   | 6,000          | $42                | ~$5          | ~$2          | **~$49**        |
| Growth | 10,000  | 60,000         | $420               | ~$25         | ~$10         | **~$455**       |
| Scale  | 100,000 | 600,000        | $4,200             | ~$100        | ~$50         | **~$4,350**     |

\*Cloudflare Workers: $5/month for 10M requests; D1: $0.75/million reads. Estimates at 10 DO ops per turn.

### Per-User Economics

| Scale                      | Monthly AI Cost/User |
| -------------------------- | -------------------- |
| All scales (Haiku default) | $0.042/user/month    |
| Premium Sonnet tier (3x)   | $0.126/user/month    |

At $0.042/user/month, YesAInd can break even with a freemium model charging $1-2/month for premium users covering free tier users at ~25:1 ratio.

---

## Model Strategy & Business Case

### Why Haiku at $0.007/Turn

Haiku 4.5 is not a cost compromise - it outperforms Sonnet 4 on this specific workload:

| Model     | Eval Score  | Cost/Turn | Stakes-Escalation | Verdict                              |
| --------- | ----------- | --------- | ----------------- | ------------------------------------ |
| Haiku 4.5 | 34/35 (97%) | $0.007    | 6/7 (86%)         | Default - tuned and shipped          |
| Sonnet 4  | 28/35 (80%) | $0.021    | 1/7 (14%)         | Blocked - over-creates during crises |

The capability inversion happens because Sonnet's superior reasoning causes elaboration ("let me add a full fire scene") when the improv format demands restraint ("use an effect, not objects"). Server-side crisis caps (maxCreates=2 for escalation turns) block most over-creation, but the eval expects effects-first behavior which Sonnet misses.

Haiku's constraint-following tendency is the feature, not the limitation.

### The Token Value Proposition

**The real cost comparison is not Haiku vs. Sonnet - it's AI-generated interactive scenes vs. static image generation:**

| Tool                      | Cost              | Output                                                                                                                              |
| ------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| YesAInd (Haiku)           | $0.007/turn       | 3-6 canvas objects: persons, props, scene drawings, SFX effects, highlights - all interactive, positioned, collaboratively editable |
| Midjourney (standard)     | ~$0.04/image      | 1 static image                                                                                                                      |
| DALL-E 3 (1024x1024)      | ~$0.04/image      | 1 static image                                                                                                                      |
| Stable Diffusion (hosted) | ~$0.01-0.02/image | 1 static image                                                                                                                      |

**YesAInd delivers 5.7x more value per dollar than Midjourney** - and the output is interactive, multiplayer, and improvable in real time. A $0.007 Haiku turn creates a living scene that players can continue building on vs. a static image that ends the creative loop.

The business model works because improv is text-and-tool-heavy (cheap tokens), not image-generation-heavy (expensive pixels). Each turn's tool calls create visual richness through composition (drawScene generates backgrounds + multiple overlapping elements as a single batchExecute call), not through image synthesis.

### Premium Tier Roadmap

When v28 prompt work lands (model-tier-aware constraints for Sonnet+), Sonnet becomes viable as a premium tier:

| Tier    | Model     | Cost/Turn | Value Add                                                               |
| ------- | --------- | --------- | ----------------------------------------------------------------------- |
| Free    | Haiku 4.5 | $0.007    | Full scene generation, all game modes                                   |
| Premium | Sonnet 4  | $0.021    | Richer narrative, more complex compositions, better multi-step planning |

At $0.021/turn, 6 turns/user/month = $0.126/user/month. A $3/month premium subscription covers ~24 users' premium AI cost, with margin for infrastructure. Sustainable SaaS economics at modest scale.

### OpenAI Cost Comparison

GPT-4.1 Mini (added to AI_MODELS in v26) offers an alternative at comparable pricing to Haiku. The toolchain supports model switching per-character (OnboardModal troupe builder), so a mixed troupe (Haiku + Mini) is possible for differentiated personas without changing the overall cost structure.

---

## Summary

YesAInd's AI cost structure is unusually favorable for an AI-native product:

1. **Dev cost was front-loaded.** ~$326 total development spend for a production-ready system with a 27-iteration prompt optimization cycle and automated eval harness. That's infrastructure investment, not ongoing burn.

2. **Production unit economics work at free tier.** $0.042/user/month means the product can sustain a generous free tier. Most AI products break even at 10-100x higher per-user costs.

3. **The model selection is accidental efficiency.** Haiku outperforming Sonnet on this workload means the cheapest viable model is also the best one. This is rare and worth preserving as a deliberate architectural constraint.

4. **Scalability is linear, not exponential.** Cloudflare Workers + Durable Objects scale horizontally without cold-start penalties or connection pool limits. AI cost grows linearly with users; infrastructure cost grows sub-linearly due to CF's pricing model.
