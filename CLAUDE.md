# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

YesAInd - multiplayer improv canvas with AI agent integration. Real-time collaborative whiteboard where players and AI improvise scenes together. Solo dev with AI-first methodology (Claude Code + Cursor).

## Stack

React + Vite + react-konva + TypeScript | Cloudflare Workers + Hono + Durable Objects | D1 + DO Storage

**Key server files:**

| File                               | What it does                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/index.ts`              | Hono routes, board CRUD, DO exports, WS upgrade, persona/replay/gallery APIs                                                                                                                      |
| `src/server/chat-agent.ts`         | ChatAgent DO - AI chat, troupe config, stage manager, audience polls/waves, persona claims, director nudges                                                                                       |
| `src/server/ai-tools-sdk.ts`       | 19 AI tools incl. askAudience (Zod schemas, batchExecute meta-tool)                                                                                                                               |
| `src/server/prompts/`              | Prompt modules: `system.ts` (core prompt), `intents.ts`, `personas.ts`, `game-modes.ts`, `dramatic-arc.ts`, `stage-manager.ts`, `reactions.ts`, `critic.ts`, `index.ts` (barrel + PROMPT_VERSION) |
| `src/server/tracing-middleware.ts` | AI SDK middleware -> D1 traces + optional Langfuse                                                                                                                                                |
| `src/server/auth.ts`               | Passkey/WebAuthn primary auth + password fallback (PBKDF2 timing-safe, D1 sessions, rate limiting)                                                                                                |
| `src/shared/types.ts`              | Persona, BoardObject, GameMode, AIModel, AI_MODELS, TroupeConfig, Poll, WaveEffect, canvas bounds constants                                                                                       |
| `src/shared/board-templates.ts`    | Template registry: typed BoardObject arrays, displayText, `getTemplateById()` for server-side seeding                                                                                             |

**Key client files:**

| File                                     | What it does                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `src/client/components/Board.tsx`        | Canvas + chat integration, mobile layout, model/persona state                 |
| `src/client/components/ChatPanel.tsx`    | AI chat sidebar, persona claim pills, intent chips, useAgentChat              |
| `src/client/components/OnboardModal.tsx` | 3-step wizard: troupe builder (per-character model select) + invite + the get |
| `src/client/components/AuthForm.tsx`     | Passkey/WebAuthn registration + login UI with password fallback               |

**AI architecture (gotchas that will bite you):**

- Anthropic + OpenAI models only (Workers AI removed in v21). `body.model` sent per-message for DO hibernation resilience.
- Per-player persona claims via `body.personaId` (same per-message pattern). Fallback: round-robin.
- Reactive persona fires via `ctx.waitUntil` after each response. First exchange unreliable (timing gap).
- Class-level state resets on DO hibernation. Client re-sends model/gameMode/personaId each message.
- Canvas bounds exported as `CANVAS_MIN_X/Y`, `CANVAS_MAX_X/Y` from shared/types.ts. Used in prompts, index.ts, chat-agent.ts.
- Default model is Claude Haiku 4.5.
- `createSDKTools()` called 6 times per user turn with per-context maxCreates budget (main=4 normal / 2 crisis, stageManager=3 normal / 1 crisis, globalMaxCreates=6 shared CreateBudget ref). SharedBounds array shares position tracking across closures.
- **Crisis-aware maxCreates:** Messages matching `CRISIS_INTENT_CHIPS` ("escalate!", "plot twist!") or `CRISIS_KEYWORDS` regex get main=2, stageManager=1 cap. Server-side backstop for when Haiku ignores the CRISIS EVENTS prompt rule. Disabled when `qaMode=true`.
- **QA bypass:** Messages starting with `qa:` (case-insensitive) set `qaMode=true`, bypassing all per-turn maxCreates caps. OOB clamping stays active. Used for stress-testing and UAT.
- **Client WS debug logging:** `localStorage.setItem('debug-ws', '1')` enables console logging of WS open/close/error/obj:create/obj:update/obj:delete events in `useWebSocket.ts`.
- Game modes: `yesand` (beginner), `freeform` (mid), `harold` (advanced). Harold uses `humanTurns` for phase coaching (Opening/First Beats/Second Beats/Third Beats).
- Templates: 2 only (superhero-hoa, pirate-therapy), shown only in yesand (beginner) mode.
- Deploy via `git push` to main (CF git integration). Never `wrangler deploy` manually.

## Prompt Tuning Notes

- **Haiku ignores soft rules.** "Create ONLY objects requested" is treated as a suggestion. Use hard caps: "NEVER create more than N objects per response."
- **getBoardState pre-check can regress simple layouts** - model wastes a tool call and loses track of constraints. Removed in v19.
- **v19 baseline (Haiku):** 3/10 layout pass, avg overlap 3.6 (down from 5.7 in v17).
- **v20 baseline (Haiku):** 4/10 layout pass, avg overlap 3.5, OOB=0. Narrative 3.2/5 (first clean judge run). Server-side enforcement eliminated OOB entirely.
- **v21 fixes:** (1) Judge pipeline now includes toolCalls in transcript (was blind to tool_usage). (2) Visual tool mandate - createPerson/drawScene required, createText restricted to dialogue. (3) maxCreates parameterized per call site (was 4 per closure x 6 closures = uncapped). (4) Game mode restructure: hat/freezetag removed, Harold added.
- **v22 fix:** Zero-tolerance overlap enforcement in `enforcedCreate()`. Threshold 0.2->0, nudge step 20px->objectWidth+16px gap, lines/connectors exempted. LLMs can't do spatial reasoning; code handles it.
- **v23 architecture:** Server-side auto-layout engine. LLMs no longer specify x,y - `flowPlace()` in `createSDKTools` closure reads existing board state (lazy-init, cached per closure) and shelf-packs new objects left-to-right, top-to-bottom with 16px gaps. Frame-aware: objects created after a frame go inside it. `drawScene` compositions bypass per-part count cap (entire composition = 1 create). `enforcedCreate()` simplified to count cap + OOB clamping only (no nudge loop). Tool schemas stripped of x,y params.
- **v25 fix:** Added CRISIS EVENTS rule. stakes-escalation eval 0/7->6/7 (86%). "NOT inside batchExecute" is load-bearing for effect tools - wrapping them makes them invisible to AI SDK toolCalls[]. maxCreates reverted main 3->4 (4th object was silently dropped at 3).
- **v26 fixes:** (1) `computeOverlapScore` excludes frames + lines - false positive fix (3 persons inside a frame were counting as 3 overlaps). (2) `flowPlace` two-pass scan: Pass 1 coarse grid (object-sized steps), Pass 2 fine-grained fallback below all content (step=objectWidth/4). Eliminates "place at origin" fallback that caused overlap=12 on dense scenes. (3) Crisis-aware maxCreates: 2/1 for escalation turns vs 4/3 normal. (4) QA bypass via `qa:` prefix. (5) Judge transcript now expands batchExecute inner tools (was blind to create tools nested inside batch). (6) GPT-4.1 Mini + Nano added to AI_MODELS. (7) Reactive persona now inherits crisis-aware maxCreates (was hardcoded=2, bypassed crisis cap). (8) tool_usage judge fix: board object delta replaces broken batchExecute expansion (judge was blind to tools inside batch - toolCalls stripped at call site + args not in WS frames).
- **v26 diag baseline (Haiku):** 34/35 (97%) via prompt-scenarios-diag.ts. Complication 7/7, character-intro 7/7, grid 7/7, color 7/7, stakes-escalation 6/7 (86%). Prior "3/10 layout pass" was from prompt-eval.ts (integration harness) with broken judge - not comparable.
- **v27 fix:** Simplified CRISIS EVENTS prompt block (7 lines -> 2). Server-side crisis cap now does the heavy lifting. Removed "NOT inside batchExecute" workaround (judge fixed). Haiku duplicate text in eval is a multi-step streamText artifact (text generated pre and post tool calls), not a code bug.
- **v27 regression:** Simplification dropped explicit ordering cues. "Prefer highlightObject + play_sfx" is a soft suggestion Haiku ignores. stakes-escalation dropped from 6/7 (86%) to 1/7 (14%). Root cause: "FIRST call X then Y" is sequencing; "Prefer X over Y" is optional. Naming concrete SFX options (thunder/dramatic-sting) eliminates deliberation that leads to creating instead.
- **v28 fix:** Restored CRISIS EVENTS explicit ordering. Changed "Prefer highlightObject + play_sfx" to "FIRST: call getBoardState then play_sfx (thunder or dramatic-sting) and highlightObject". Hard prohibition: "Do NOT create new persons, frames, or scene objects during a crisis." stakes-escalation: 6/7 (86%, avg 100/100). Full suite: 35/35.
- **Sonnet 4 capability inversion:** Sonnet scores 28/35 (80%) vs Haiku 34/35 (97%) on same prompt. stakes-escalation catastrophic: 1/7 (14%). Sonnet over-creates during crises because superior reasoning causes elaboration (full fire scenes) instead of restraint (effects). Server-side cap blocks most over-creation but eval expects effects-first behavior. Fix path: model-tier-aware prompt injection with harder constraints for Sonnet+ models. See task #243.
- **Model strategy:** Haiku 4.5 is the tuned default ($1/$5 per MTok, ~$0.007/turn). Sonnet requires v28 prompt work before it can be a premium tier ($3/$15 per MTok, ~$0.021/turn). Don't ship Sonnet as default until prompt is tuned for it.
- **Quality signal feature:** Deployed in v26 (commit 306f76e), gated by `QUALITY_SIGNAL_ENABLED="true"` env var (off by default). Per-turn Haiku judge scoring: yesAnd, characterConsistency, sceneAdvancement, toolAppropriateness (0-3 each). Fires via ctx.waitUntil after reactive persona. WARNING: raw scores log may contain player dialogue fragments - fix before enabling in prod (log only dimension names + values, not full raw object).
- **Eval command:** `set -a && source .dev.vars && set +a && EVAL_MODEL=claude-haiku-4.5 npm run eval` (must use `set -a` to export vars to child processes).
- **Standalone eval (no server):** `set -a && source .dev.vars && set +a && npx tsx scripts/prompt-scenarios-diag.ts` - calls Anthropic API directly, no wrangler/dev server needed. Preferred for prompt/layout validation. Always redirect output: `> /tmp/eval-diag.txt 2>&1` then read the file. Never re-run to get different output slices.

## Langfuse / Observability

- **Langfuse trace anatomy:** Each user turn produces 2-3 `chat` traces (multi-step `streamText` artifact, not a bug) + 1 `reactive` trace (second persona) + optional `director`/`canvas-action` traces. Trace metadata includes `boardId`, `promptVersion`, `gameMode`, `scenePhase`, `intentChip`. Tags: `persona:X`, model name, trigger type. Access via `LANGFUSE_BASE_URL` (not `LANGFUSE_HOST`) + Basic auth with `LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY`. Delete API rate-limits at ~2,500 ops then 429s for ~60s. Bulk delete from UI is faster.
- **Langfuse gaps (as of v27):** (1) `totalCost` is $0.00 on all traces - tracing middleware doesn't pass model pricing to Langfuse. (2) Quality signal scores aren't attached as Langfuse scores (logged locally only). (3) No `sessionId` set - traces aren't grouped by board session in the dashboard.

## Commands

```bash
# Dev
npm run dev              # build once + wrangler dev (no HMR/watchers)
npm run dev:hmr          # Vite HMR + wrangler dev (escape hatch if live editing needed)
npm run health           # wait for dev server (polls 500ms) - use instead of sleep

# Build & Deploy (CF git integration auto-deploys on push to main)
npm run build            # Vite build
npm run deploy           # Vite build + wrangler deploy (manual fallback)

# D1 Migrations (tracked via d1_migrations table)
npx wrangler d1 migrations create collabboard-db "describe_change"  # create new
npm run migrate              # apply pending to local + remote
npm run migrate:local        # apply pending to local only
npm run migrate:remote       # apply pending to remote only

# Prompt Eval Harness (requires dev server running)
# IMPORTANT: use set -a to export .dev.vars - eval/judge scripts need API keys as child process env vars
set -a && source .dev.vars && set +a && EVAL_MODEL=claude-haiku-4.5 npm run eval   # run all scenarios
# EVAL_USERNAME/EVAL_PASSWORD/EVAL_MODEL env vars override defaults (eval/eval1234/glm-4.7-flash)
# EVAL_SCENARIO=scene-setup npm run eval   # single scenario (T1, ~30s)
# npm run eval:smoke                        # smoke suite: scene-setup, complication, character-intro, stakes-escalation (T2, ~2min)
# npm run eval                              # full suite (T3, ~5min)
# EVAL_SCENARIO=scene-setup,grid-2x2 npm run eval  # comma-separated scenario IDs
# EVAL_TAG=smoke npm run eval               # filter by tag (equivalent to eval:smoke)
# JSON reports written to scripts/eval-results/<timestamp>.json (gitignored, kept on disk for reference)
# Quick summary: jq '{model, layout: "\(.layout.passed)/\(.layout.total)", overlap: .layout.avgOverlap}' scripts/eval-results/*.json
# Compare runs: npm run eval:compare scripts/eval-results/A.json scripts/eval-results/B.json

# Prompt Diagnostic Scripts (require dev server running + .dev.vars sourced)
npx tsx scripts/prompt-genetic.ts          # genetic prompt tuner (30 iterations, ~2min)
npx tsx scripts/prompt-scenarios-diag.ts   # multi-scenario diagnostic (7 runs each, ~3min)

# Format & Audit
npm run format           # prettier --write
/audit                   # on-demand code quality checks (replaced ESLint)

# Type Check (always use npm run typecheck, not bare tsc)
npm run typecheck        # wrangler types + tsc --noEmit (generates CF Workers bindings first)
# NEVER use bare `npx tsc --noEmit` - it skips wrangler types and shows false CF type errors

# Dependency Updates
npm run update-deps      # bumps all deps except vite/plugin-react (major), then npm ci
```

## Git Worktrees

After worktree creation, run `npm ci` to install deps (lockfile-only, fast). If the agent needs API keys (eval, dev server), copy `.dev.vars`: `cp /Users/tomfuertes/sandbox/git-repos/yesaind/.dev.vars .dev.vars`.

See `~/.claude/CLAUDE.md` for universal worktree conventions (merge safety, absolute paths, isolation).

## Browser Testing (playwright-cli)

See `~/.claude/CLAUDE.md` for universal browser testing conventions (artifacts dir, proactive use, snapshots vs screenshots, sandbox flag).

**UAT and quality exploration swarms should target production** (`https://yesaind.com`), not localhost. Prod is what real users see and avoids wrangler dev quirks (DO cold starts, WS flakiness, single-IP rate limit buckets). Only use localhost for testing uncommitted code changes.

```bash
# Basic flow
playwright-cli open http://localhost:5173    # open app (localhost for dev)
playwright-cli snapshot                       # get element refs (e.g., e3, e15)
playwright-cli fill e5 "username"             # interact by ref
playwright-cli click e3                       # click by ref
playwright-cli screenshot --filename=playwright/verify.png  # visual verification
playwright-cli close                          # cleanup

# Two-browser sync testing (primary validation method)
playwright-cli -s=user1 open http://localhost:5173
playwright-cli -s=user2 open http://localhost:5173
# ...interact in each session independently...
playwright-cli close-all

# Auth state
playwright-cli cookie-list                    # inspect session cookies
playwright-cli state-save auth-user1.json     # save auth state for reuse
playwright-cli state-load auth-user1.json     # restore auth state
```

### E2E Tests (Playwright)

```bash
npx playwright test                    # run all tests
npx playwright test e2e/sync.spec.ts   # run one file
npx playwright test --reporter=dot     # minimal output (default 'list' floods context)
```

**Known gotchas:**

- **Reactive persona UAT timing:** SAGE/reactive persona reliably triggers on the 2nd+ exchange, not the 1st (timing gap: `ctx.waitUntil` fires before base class adds the new assistant message to `this.messages`). GLM reactive `generateText` takes 30-40s. UAT must send a follow-up message before testing SAGE, then wait 45-60s.
- **WS flakiness in local dev is expected.** First WS connection often drops with wrangler dev (DO cold start during WS handshake). The app reconnects but E2E/UAT tests must account for this. **After navigating to a board, always wait for `[data-state="connected"]` before interacting.** This selector is on the connection status dot in the header. Use `createObjectsViaWS()` helper (in `e2e/helpers.ts`) instead of UI double-click for reliable object creation. `wsRef.current` can be null after a drop even when React state shows "connected".
- **HMR hook-order false positive:** "React has detected a change in the order of Hooks called by Board" during dev = Vite HMR artifact, not a real bug. Full page reload fixes it. Never investigate this error in a live dev session.
- **UAT auth: use API, not UI.** Password login UI doesn't reliably navigate to board list in headless playwright-cli. Use the API directly instead: `POST /auth/signup {username, password}` to register, `POST /api/boards {name}` to create a board (returns `{id}`), then navigate to `/#board/<id>`. Wait for "Double-click to add a sticky" text or `[data-state="connected"]` before interacting. See `e2e/helpers.ts` `signUp()` / `createBoard()` / `navigateToBoard()` for the canonical pattern.
- **OnboardModal requires `sessionStorage` initiator key.** Direct hash navigation (`/#board/<id>`) never sets `yesaind:initiator:<boardId>=1`, so the board shows "Waiting for curtains" (WaitingCurtainsModal) instead of the onboarding wizard. Fix before testing: `playwright-cli evaluate "sessionStorage.setItem('yesaind:initiator:<boardId>', '1')"` then reload. The modal renders when `initialized && objects.size === 0 && !boardGenStarted && isInitiator`.
- **`#board/<id>` vs `#watch/<id>` are different routes.** `#board/` = interactive canvas (Board.tsx). `#watch/` = read-only spectator view (SpectatorView.tsx) which shows "Waiting for curtains" for show boards. UAT agents sometimes navigate to `#watch/` by mistake - always use `/#board/<boardId>` for interactive testing.
- **Verify API data via in-page fetch, not curl.** The board objects API requires an auth cookie. Use playwright-cli to run in the page console: `fetch('/api/boards/<id>/objects').then(r=>r.json()).then(d=>console.log(JSON.stringify(d.filter(o=>o.type==='image'))))` - this uses the session cookie automatically. Checking `isBackground`, `width`, `height` this way is faster than any other approach.
- **FPS overlay "Objects N" counts Konva tree nodes, not BoardObjects.** A single `createPerson` call produces ~6-8 Konva nodes (group + shape + text + etc). Don't use it to measure object creation counts during UAT - read the board via `GET /api/boards/:boardId/objects` or count visible named objects in a snapshot instead.

## Architecture

### Monorepo Layout

```
src/
  client/               # React SPA
    App.tsx             # Hash routing (#board/{id}, #replay/{id}, #watch/{id}, #gallery)
    theme.ts            # Color constants (accent, surfaces, cursors)
    components/
      Board.tsx         # Canvas + chat + mobile layout (<=768px responsive)
      Toolbar.tsx       # Floating tool buttons, mode switching
      BoardObjectRenderer.tsx  # Konva shape renderer (all object types)
      BoardList.tsx     # Board grid (CRUD) - landing page
      ChatPanel.tsx     # AI chat sidebar, persona claim pills, intent chips
      CanvasPreview.tsx # Mobile read-only canvas strip
      ReplayViewer.tsx  # Public scene replay (no auth)
      SpectatorView.tsx # Public live view + emoji reactions + poll voting (no auth)
      SceneGallery.tsx  # Public gallery grid (#gallery)
      PerfOverlay.tsx   # FPS/connection overlay (Shift+P)
      AiCursor.tsx      # Purple dot animating to AI creation points
      WaveEffect.tsx    # Audience wave canvas effects (confetti, shake, glow, etc.)
      # Also: Button, Modal, TextInput, ConnectionToast, ConfettiBurst, BoardGrid
    hooks/
      useWebSocket.ts        # Board DO WebSocket state
      useSpectatorSocket.ts  # Spectator WebSocket (read-only)
      useUndoRedo.ts         # Local undo/redo (max 50)
      # Also: useThrottledCallback, useAiObjectEffects, useKeyboardShortcuts,
      #       useDragSelection, useIsMobile
    styles/
      animations.css    # Shared keyframes
  server/               # (see Stack tables above for server files)
  shared/types.ts       # BoardObject, WSMessage, Persona, GameMode, AIModel, TroupeConfig, Poll, WaveEffect
migrations/             # D1 SQL (npm run migrate)
```

### Data Flow

1. Auth via passkey/WebAuthn (primary: /auth/passkey/register|login/options+verify) or password fallback (/auth/signup, /auth/login); issues session cookie
2. BoardList (`GET /api/boards`) -> select/create board -> `#board/{id}`
3. WebSocket to `wss://host/board/:id` (cookie validated before upgrade)
4. Board DO manages state: objects in DO Storage (`obj:{uuid}`), cursors in memory
5. Mutations: client optimistic -> DO persists + broadcasts to others
6. AI: client WS to ChatAgent DO (`/agents/ChatAgent/<boardId>`) -> `streamText()` with tools -> Board DO RPC for canvas mutations
7. Replay: DO records mutations as `evt:{ts}:{rand}` keys (max 2000). Public `GET /api/boards/:id/replay`
8. Gallery: Public `GET /api/boards/public` (D1 join). `#gallery` -> `#replay/{id}`
9. Spectator: `GET /ws/watch/:boardId` (no auth). Read-only + cursor/reactions/poll votes
10. Eval API: `GET /api/boards/:boardId/objects` returns objects + quality metrics

### WebSocket Protocol

```
Player -> DO:    cursor | obj:create | obj:update | obj:delete | batch:undo | reaction
Spectator -> DO: cursor | reaction | poll:vote (all other messages silently dropped)
DO -> Client:    cursor | obj:create | obj:update | obj:delete | presence | init | reaction | poll:start | poll:result | audience:wave
```

DO echoes mutations to OTHER clients only (sender already applied optimistically). Presence messages include `spectatorCount` (number of anonymous spectator connections). Reactions are broadcast to ALL clients (including sender - no optimistic apply). Reaction emoji whitelist + 1/sec rate limit enforced server-side.

**IMPORTANT:** The WS message field for objects is `obj` (not `object`). Example: `{ type: "obj:create", obj: { id, type, x, y, ... } }`. Using `object` instead of `obj` silently fails - the DO ignores the message.

**Ephemeral state TTL pattern:** For cursor-like state that relies on explicit cleanup messages (e.g. `text:blur`), also track `lastSeen` + sweep with `setInterval`. Messages can be dropped on WS disconnect; TTL ensures eventual consistency without server changes.

**DO hibernation:** Class-level properties reset on hibernation. Store ephemeral per-connection state in `ws.serializeAttachment()` - survives hibernation and is readable in `webSocketClose`. Rate-limit maps (e.g. `lastReactionAt`) reset on hibernation, which is correct - the cooldown is short-lived and doesn't need persistence.

### Board Object Shape

```typescript
{ id, type, x, y, width, height, rotation, props: { text?, color?, fill?, stroke?, arrow?, src?, prompt? }, createdBy, updatedAt, batchId? }
```

Each object stored as separate DO Storage key (`obj:{uuid}`, ~200 bytes). LWW via `updatedAt`. `batchId` groups AI-created objects from a single `streamText` call for batch undo. Replay events stored as `evt:{16-padded-ts}:{4-char-rand}` keys (max 2000, `obj:update` debounced 500ms per object).

## Key Constraints

- Deploy via `git push` to main (CF git integration). Never `wrangler deploy` manually.
- `_isGenerating` mutex uses `withGenerating()` try/finally wrapper. `onChatMessage` extends its try block manually (streaming outlives function scope). Rate check must happen BEFORE claiming mutex.
- Never expose API keys to client bundle - all AI calls server-side.
- `getUserColor(userId)` is hash-based (not array-index). Same palette in Board.tsx and Cursors.tsx.
- Dev: `scripts/dev.sh` raises `ulimit -n 10240` (macOS default 256 causes EMFILE in multi-worktree).
- Wrangler auth: `env.AI` binding is `remote` mode - requires `wrangler login` or `CLOUDFLARE_API_TOKEN` even in local dev. Server won't start without auth. Eval models (Anthropic/OpenAI) don't use this binding but wrangler still requires auth to boot. To stub out for offline dev, comment out `[ai]` block in wrangler.toml.
- `batchExecute` wraps create tools only. Effect/control tools (`highlightObject`, `play_sfx`, `getBoardState`, `askAudience`) must be called directly - wrapping them in `batchExecute` makes them invisible to AI SDK `toolCalls[]`.

## Doc Sync

- **No session notes or docs/ files.** `docs/` directory was removed. Task list + git log is the source of truth.

See `~/.claude/CLAUDE.md` for session start ritual and doc sync conventions.

## Custom Agents (Delegation)

See `~/.claude/CLAUDE.md` for agent workflow, model selection, and team conventions. Below is project-specific delegation config.

| Task                  | Agent                 | Model  | Mode                | How                                   |
| --------------------- | --------------------- | ------ | ------------------- | ------------------------------------- |
| Feature worktree      | `general-purpose`     | sonnet | `bypassPermissions` | team member                           |
| Design / architecture | `general-purpose`     | opus   | `bypassPermissions` | team member                           |
| UAT / smoke test      | `uat`                 | sonnet | `bypassPermissions` | team member                           |
| Quality exploration   | `general-purpose`     | sonnet | `bypassPermissions` | team member                           |
| PR review             | `pr-review-toolkit:*` | sonnet | default             | invoked by worktree agent via Skill   |
| E2E / eval harness    | `general-purpose`     | sonnet | `bypassPermissions` | team member (reports via SendMessage) |
| Codebase exploration  | `Explore` (built-in)  | sonnet | default             | team member or background (atomic)    |

**Agent prompts must explicitly mention:**

- **Browser tool in devcontainer: both playwright-cli and agent-browser may be unavailable.** Check first: `which playwright-cli && playwright-cli --version || echo "not found"`. If missing, do NOT fall back to writing cold playwright test scripts (you won't know selectors and will waste time). Instead: (1) for quantitative prompt quality, run `npx tsx scripts/prompt-scenarios-diag.ts` - no browser needed; (2) for regression, use `npx playwright test` against existing e2e/ specs; (3) for new interactive UAT scenarios, read the component source to extract selectors first, then write the spec. Never `sleep 120` waiting for AI responses - poll `/api/boards/{id}/objects` every 3-5s with a timeout instead.

- **Dev server startup** (only if UAT/eval needed): `npx wrangler whoami` first to verify auth. If not authenticated, escalate to team-lead immediately - do not attempt `npm run dev`. If auth OK: `npm run dev` with `run_in_background: true` and `dangerouslyDisableSandbox: true`. Wait 8s, read background task output to confirm no errors, THEN `npm run health`. If dev server errors, do NOT retry - escalate immediately via SendMessage with full error output.
- "Read CLAUDE.md and relevant source files before implementing"
- "Commit all changes to the feature branch. Do not open a PR."
- **KEY-DECISION comments**: `// KEY-DECISION <YYYY-MM-DD>: <rationale>` at the code location.
- `"Write your implementation plan to $TMPDIR/plan-{task-id}.md before coding"` - if the agent runs out of context, the orchestrator can read the plan to assess progress and hand off cleanly.
- Agents should prefer atomic tool calls over exploratory browsing to conserve context window.

## Conventions

- TypeScript strict mode
- camelCase variables/functions, PascalCase components/types, kebab-case utility files
- Prettier enforced; /audit skill for on-demand code quality checks
- Feature-based organization on client side
- Vertical slices - each increment delivers user-visible behavior
- Never break sync - every commit should pass the 2-browser test
