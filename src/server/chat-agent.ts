import { AIChatAgent } from "@cloudflare/ai-chat";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText, generateText, convertToModelMessages, stepCountIs } from "ai";
import type { UIMessage, StreamTextOnFinishCallback, ToolSet } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createWorkersAI } from "workers-ai-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createSDKTools, isPlainObject, rectsOverlap, generateImageDataUrl } from "./ai-tools-sdk";
import type { CreateBudget, SharedBounds } from "./ai-tools-sdk";
import { createTracingMiddleware, wrapLanguageModel, Langfuse } from "./tracing-middleware";
import {
  SYSTEM_PROMPT,
  SCENE_SETUP_PROMPT,
  INTENT_PROMPTS,
  MOMENTUM_PROMPT,
  DIRECTOR_PROMPTS,
  DIRECTOR_PROMPTS_HAROLD,
  DIRECTOR_PROMPTS_YESAND,
  PROMPT_VERSION,
  computeScenePhase,
  MAX_AUTONOMOUS_EXCHANGES,
  buildPersonaSystemPrompt,
  buildRelationshipBlock,
  computeBudgetPhase,
  BUDGET_PROMPTS,
  buildGameModePromptBlock,
  computeLifecyclePhase,
  buildLifecycleBlock,
  CRITIC_PROMPT,
  buildCanvasReactionPrompt,
  buildTagOutPrompt,
  PLOT_TWISTS,
  buildPlotTwistPrompt,
  buildHecklePrompt,
  buildPollResultPrompt,
  buildWavePrompt,
  buildSfxReactionPrompt,
  buildDirectorNotePrompt,
  buildQACommandPrompt,
  buildStageManagerPrompt,
  buildQualitySignalPrompt,
} from "./prompts";
import type { GameModeState, QualitySignalScores } from "./prompts";
import type { Bindings } from "./env";
import { recordBoardActivity } from "./env";
import type {
  BoardObject,
  BoardObjectProps,
  AIModel,
  BoardStub,
  CanvasAction,
  CharacterRelationship,
  GameMode,
  Persona,
  SceneLifecyclePhase,
  TroupeConfig,
} from "../shared/types";
import {
  SCENE_TURN_BUDGET,
  DEFAULT_PERSONAS,
  AI_MODELS,
  AI_USER_ID,
  CANVAS_MIN_X,
  CANVAS_MIN_Y,
  CANVAS_MAX_X,
  CANVAS_MAX_Y,
} from "../shared/types";
import { getTemplateById } from "../shared/board-templates";

/**
 * Strip leaked model internals from output text: <think> blocks, <tool_call> fragments,
 * and content before stray </think> tags. GLM 4.7 Flash leaks these into visible chat by
 * exchange 3+, causing 1000-3000+ word circular reasoning blobs in the UI.
 *
 * KEY-DECISION 2026-02-19: Applied at 3 sites - display (ensurePersonaPrefix),
 * message construction (buildGenerateTextMessage), and history storage (both above).
 * Cleaning at construction time handles both display AND history pollution in one pass.
 */
function cleanModelOutput(text: string): string {
  // Strip <think>...</think> blocks (multiline, lazy - handles multiple blocks correctly)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  // Strip <tool_call>...</tool_call> fragments
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
  // Strip content before stray </think> tags (partial leak: block opened but truncated before close)
  const strayThinkClose = cleaned.indexOf("</think>");
  if (strayThinkClose !== -1) {
    cleaned = cleaned.slice(strayThinkClose + "</think>".length);
  }
  // Strip stray <tool_call> without closing tag (truncated leak)
  const strayToolCall = cleaned.indexOf("<tool_call>");
  if (strayToolCall !== -1) {
    cleaned = cleaned.slice(0, strayToolCall);
  }
  // Strip leading markdown heading markers (e.g. "# Previously on..." from recap narration)
  cleaned = cleaned.replace(/^#+\s+/, "");
  return cleaned.trim();
}

/**
 * Blocklist for output moderation. Covers slurs, explicit sexual content, and harmful instructions.
 * Not a general profanity filter - mild improv language (damn, hell, ass) is fine.
 *
 * KEY-DECISION 2026-02-20: Simple regex blocklist over external moderation API.
 * No added latency, no cost, no external dependency. ~20 patterns cover the obvious
 * harm vectors (slurs, explicit sexual, hate speech, harmful instructions) for a public
 * improv gallery. Word-boundary anchors + leet-speak variants prevent easy circumvention.
 */
const CONTENT_BLOCKLIST: RegExp[] = [
  // Racial and ethnic slurs
  /\bn[i!1][gq]{2}[ae3]r\b/i,
  /\bf[a@4][gq]{2}[o0]t\b/i,
  /\bk[i!1]k[e3]\b/i,
  /\bsp[i!1][ck]\b/i,
  /\bch[i!1]nk\b/i,
  /\bwetback\b/i,
  // Explicit sexual content (not mild innuendo)
  /\bpornograph/i,
  /\bsex(?:ual)?\s+(?:explicit|assault|traffic)/i,
  /\bchild\s+(?:sex|porn|nude)/i,
  /\bminor\s+(?:sex|porn|nude)/i,
  // Hate speech
  /\bheil\s+hitler\b/i,
  /\bwhite\s+(?:power|supremac)/i,
  /\bgas\s+the\s+\w+s\b/i,
  // Harmful real-world instructions
  /\b(?:make|build)\s+(?:a\s+)?(?:bomb|explosive)\b/i,
  /\bhow\s+to\s+(?:make|synthesize)\s+\w*(?:drug|meth|fentanyl)/i,
  /\bhow\s+to\s+(?:kill|murder|poison)\s+(?:a\s+)?(?:person|someone|people)\b/i,
  /\bkill\s+(?:your|ur)self\b/i,
];

/**
 * Sanitize AI output text against the content blocklist.
 * Returns a safe replacement string if flagged; original text otherwise.
 * Applied at all AI response output points before persisting to message history.
 */
function moderateOutput(boardId: string, text: string): string {
  for (const pattern of CONTENT_BLOCKLIST) {
    if (pattern.test(text)) {
      console.warn(JSON.stringify({ event: "moderation:flagged", boardId, pattern: pattern.source }));
      return "[scene paused for content review]";
    }
  }
  return text;
}

/** Check if text contains flagged content (exported for gallery gate in index.ts). */
export function containsFlaggedContent(text: string): boolean {
  return CONTENT_BLOCKLIST.some((p) => p.test(text));
}

/**
 * Sanitize UIMessages to ensure all tool invocations are safe to replay.
 *
 * Covers two classes of bugs that cause Anthropic API errors when conversation
 * history is sent back to the model:
 *
 * 1. Malformed tool inputs (null/array instead of object) - causes
 *    "Input should be a valid dictionary" errors.
 *
 * 2. Orphaned tool_use blocks - assistant messages with tool-call parts in
 *    state "input-available" or "input-streaming" have no corresponding
 *    tool_result in the history (the tool never ran). convertToModelMessages
 *    emits the tool-call content block but no tool-result block, causing
 *    Anthropic's "tool_use IDs without tool_result blocks" error. Fix: strip
 *    those parts entirely so the orphaned call never reaches the API.
 *
 * KEY-DECISION 2026-02-22: Stripping incomplete tool parts is safe - these
 * are streaming artifacts from aborted/interrupted multi-step calls. The
 * model has no memory of them; omitting them from history is correct.
 */
function sanitizeMessages(messages: UIMessage[]): { messages: UIMessage[]; repairedCount: number } {
  let repairedCount = 0;
  const sanitized = messages.map((msg) => {
    if (msg.role !== "assistant" || !msg.parts) return msg;

    let needsRepair = false;
    const cleanedParts = msg.parts
      .filter((part) => {
        const p = part as any;
        // Strip incomplete tool parts that produce orphaned tool_use blocks.
        // "input-streaming" = call still being streamed (interrupted mid-stream).
        // "input-available" = call received but execution never started.
        // convertToModelMessages emits tool-call for both but no tool-result,
        // causing Anthropic API error: "tool_use IDs without tool_result blocks".
        const isOrphaned =
          (typeof p.type === "string" &&
            p.type.startsWith("tool-") &&
            p.type !== "dynamic-tool" &&
            (p.state === "input-streaming" || p.state === "input-available")) ||
          (p.type === "dynamic-tool" && (p.state === "input-streaming" || p.state === "input-available"));
        if (isOrphaned) {
          needsRepair = true;
          console.warn(
            JSON.stringify({
              event: "ai:sanitize:orphan-tool",
              tool: p.type === "dynamic-tool" ? p.toolName : p.type.slice(5),
              state: p.state,
              toolCallId: p.toolCallId,
            }),
          );
          return false;
        }
        return true;
      })
      .map((part) => {
        const p = part as any;

        // Static tool parts (from streamText): type is "tool-<toolName>"
        // AI SDK v6 names these "tool-createStickyNote", "tool-getBoardState", etc.
        if (
          typeof p.type === "string" &&
          p.type.startsWith("tool-") &&
          p.type !== "dynamic-tool" &&
          !isPlainObject(p.input)
        ) {
          needsRepair = true;
          console.warn(
            JSON.stringify({
              event: "ai:sanitize:input",
              tool: p.type.slice(5),
              inputType: p.input === null ? "null" : Array.isArray(p.input) ? "array" : typeof p.input,
              toolCallId: p.toolCallId,
            }),
          );
          return { ...p, input: {} };
        }

        // dynamic-tool parts (from director generateText)
        if (p.type === "dynamic-tool" && !isPlainObject(p.input)) {
          needsRepair = true;
          console.warn(
            JSON.stringify({
              event: "ai:sanitize:input",
              tool: p.toolName,
              inputType: p.input === null ? "null" : Array.isArray(p.input) ? "array" : typeof p.input,
              toolCallId: p.toolCallId,
            }),
          );
          return { ...p, input: {} };
        }

        return part;
      });

    if (needsRepair) {
      repairedCount++;
      return { ...msg, parts: cleanedParts };
    }
    return msg;
  });
  return { messages: sanitized, repairedCount };
}

/**
 * Build a shimmed Workers AI language model with tool_choice:"auto" injected.
 * workers-ai-provider v3.1.1 drops tool_choice from buildRunInputs (CF issue #404).
 * Shim injects tool_choice:"auto" when tools are present; no-op otherwise.
 * Used for all 4 Workers AI call sites to avoid repeating the cast pattern.
 */
function getShimmedWorkersAI(env: Bindings, modelId: string): LanguageModelV3 {
  // Partial Ai binding - shim only needs run(). Cast satisfies createWorkersAI's type requirement.
  const shimmedBinding = {
    run: (model: string, inputs: Record<string, unknown>, options?: unknown) => {
      const hasTools = !!(inputs?.tools && (inputs.tools as unknown[]).length > 0);
      console.debug(
        JSON.stringify({
          event: "ai:shim",
          model,
          hasTools,
          toolCount: hasTools ? (inputs.tools as unknown[]).length : 0,
          hadToolChoice: !!inputs?.tool_choice,
          injecting: hasTools,
        }),
      );
      // Ai.run() overloads don't accept generic Record<string,unknown> inputs
      return (env.AI as any).run(model, hasTools ? { ...inputs, tool_choice: "auto" } : inputs, options);
    },
  } as unknown as Ai;
  const factory = createWorkersAI({ binding: shimmedBinding });
  // TextGenerationModels is not exported by workers-ai-provider; cast to accept runtime string ID
  return (factory as unknown as (id: string) => LanguageModelV3)(modelId);
}

export class ChatAgent extends AIChatAgent<Bindings> {
  // KEY-DECISION 2026-02-20: Cap at 100 messages. Each scene = 1 user msg + 1 AI + 1 reactive
  // per turn. SCENE_TURN_BUDGET caps human turns, so max ~3x turns msgs + overhead fits well
  // under 100. This prevents unbounded DO Storage growth across scenes on the same board.
  maxPersistedMessages = 100;

  // Lightweight mutex: prevents concurrent AI generation (chat + director).
  // Do NOT replace with _activeStreamId - it's unreliable after DO hibernation.
  // (ResumableStream.restore() picks up stale stream metadata with a 5-min threshold,
  // causing false positives that permanently block director nudges on prod.)
  private _isGenerating = false;

  // Multi-agent persona state (resets on DO hibernation - that's fine, defaults work)
  private _activePersonaIndex = 0; // which persona responds to the next human message
  private _autonomousExchangeCount = 0; // consecutive autonomous exchanges (reset on human msg)

  // KEY-DECISION 2026-02-19: Per-message ephemeral pattern (same as body.model/body.gameMode).
  // Claims reset on DO hibernation; client re-sends personaId on every message so DO wakes up
  // knowing the claim without any persistence layer. This avoids D1 writes for ephemeral state.
  private _personaClaims = new Map<string, string>(); // username -> Persona.id

  // Game mode state (resets on DO hibernation - client re-sends gameMode on each message)
  private _gameMode: GameMode = "freeform";
  private _yesAndCount = 0;

  // Per-message requested model (resets on DO hibernation - client re-sends model on each message)
  private _requestedModel = "";

  // Per-user AI rate limit (30 msg/min per username). Resets on DO hibernation - that's fine,
  // the window is short and we'd rather allow traffic after a cold start than block it.
  private _userRateLimit = new Map<string, { count: number; windowStart: number }>();

  // Daily AI budget tracking (resets on DO hibernation - conservative, prevents runaway spend)
  private _dailySpendNeurons = 0;
  private _dailySpendDate = ""; // YYYY-MM-DD UTC, resets when date changes

  // Langfuse client - lazily initialized on first request, null if env vars absent.
  // undefined = not yet checked; null = env vars missing, skip; Langfuse = active.
  private _langfuseClient: Langfuse | null | undefined = undefined;

  // Plot twist state - tracks whether the one-shot twist has fired this scene.
  // Resets at scene start (messages.length <= 1) and on DO hibernation (acceptable: short-lived).
  private _plotTwistUsed = false;

  // Canvas reaction engine state (resets on DO hibernation - correct, short-lived debounce state)
  // Persistent schedule (onCanvasReaction) wakes the DO; empty buffer guard handles the stale-schedule case.
  private _pendingCanvasActions: CanvasAction[] = [];
  private _canvasReactionCooldownUntil = 0;
  private _lastHumanMessageAt = 0;

  // Heckler mode: audience one-liners buffered and injected into next AI response system prompt
  private _pendingHeckles: string[] = [];
  // Sound Board: SFX cues from players, consumed by onSfxReaction (fast 2s timer)
  private _pendingSfxLabels: string[] = [];
  // Audience wave: atmospheric context injected into next AI response (resets on hibernation - correct)
  private _pendingWavePrompts: string[] = [];
  // Poll result: last completed poll result, injected into next AI response then cleared
  private _pendingPollResult: import("../shared/types").PollResult | null = null;

  /** Check if daily AI budget is exhausted. Returns true if over budget. */
  private _isOverBudget(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (this._dailySpendDate !== today) {
      this._dailySpendNeurons = 0;
      this._dailySpendDate = today;
    }
    // $0.011 per 1K neurons -> budget_usd / 0.011 * 1000 = max neurons
    const maxNeurons = (parseFloat(String(this.env.DAILY_AI_BUDGET_USD) || "5") / 0.011) * 1000;
    return this._dailySpendNeurons >= maxNeurons;
  }

  /** Track neuron usage after a request (rough estimate: ~1 neuron per token) */
  private _trackUsage(inputTokens: number, outputTokens: number) {
    const today = new Date().toISOString().slice(0, 10);
    if (this._dailySpendDate !== today) {
      this._dailySpendNeurons = 0;
      this._dailySpendDate = today;
    }
    this._dailySpendNeurons += inputTokens + outputTokens;
  }

  /** Rate-limit AI messages per user: 30/min. Returns limited=true with retryAfter seconds. */
  private _checkUserRateLimit(username: string): {
    limited: boolean;
    retryAfter: number;
  } {
    const LIMIT = 30;
    const WINDOW_MS = 60_000;
    const now = Date.now();
    const entry = this._userRateLimit.get(username);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      this._userRateLimit.set(username, { count: 1, windowStart: now });
      return { limited: false, retryAfter: 0 };
    }
    if (entry.count >= LIMIT) {
      const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
      return { limited: true, retryAfter };
    }
    entry.count++;
    return { limited: false, retryAfter: 0 };
  }

  /** Load board personas from D1, falling back to defaults on error or empty result.
   *  Never throws - D1 failures degrade gracefully to defaults with a logged warning. */
  private async _getPersonas(): Promise<Persona[]> {
    try {
      const { results } = await this.env.DB.prepare(
        "SELECT id, name, trait, color FROM board_personas WHERE board_id = ? ORDER BY created_at",
      )
        .bind(this.name)
        .all<Persona>();
      return results.length > 0 ? (results as Persona[]) : [...DEFAULT_PERSONAS];
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "personas:load-error",
          boardId: this.name,
          error: String(err),
        }),
      );
      return [...DEFAULT_PERSONAS];
    }
  }

  /** Load effective persona list for this scene.
   *  When a troupeConfig is stored in DO (written on first exchange by _runStageManager),
   *  filters to only the personas named in the troupe. Falls back to all personas.
   *  KEY-DECISION 2026-02-21: body override for onChatMessage path (avoids ordering issue:
   *  _getEffectivePersonas runs before _runStageManager writes to DO storage on first exchange).
   *  Client sends body.troupeConfig on every message (hibernation pattern), so override is always
   *  available in onChatMessage. Reactive/director paths skip override - they use DO storage. */
  private async _getEffectivePersonas(override?: TroupeConfig): Promise<Persona[]> {
    const allPersonas = await this._getPersonas();
    const config = override ?? (await this.ctx.storage.get<TroupeConfig>("troupeConfig"));
    if (!config || config.members.length === 0) return allPersonas;
    const troupeIds = new Set(config.members.map((m) => m.personaId));
    const filtered = allPersonas.filter((p) => troupeIds.has(p.id));
    return filtered.length > 0 ? filtered : allPersonas;
  }

  /** Resolve which persona should respond to the current message.
   *  If the username has a claimed personaId that still exists in the personas array, use it.
   *  Otherwise fall back to round-robin via _activePersonaIndex (backward compatible). */
  private _resolveActivePersona(
    personas: Persona[],
    username?: string,
  ): { activeIndex: number; activePersona: Persona; otherPersona: Persona | undefined } {
    let activeIndex = this._activePersonaIndex % personas.length;
    if (username) {
      const claimedId = this._personaClaims.get(username);
      if (claimedId) {
        const claimedIndex = personas.findIndex((p) => p.id === claimedId);
        if (claimedIndex !== -1) {
          activeIndex = claimedIndex;
        }
      }
    }
    const activePersona = personas[activeIndex];
    const otherPersona = personas.length > 1 ? personas[(activeIndex + 1) % personas.length] : undefined;
    return { activeIndex, activePersona, otherPersona };
  }

  /** Resolve the selected model entry from AI_MODELS registry.
   *  Priority: per-message requested model > DEFAULT_AI_MODEL env var > undefined (Workers AI fallback) */
  private _resolveModelEntry() {
    const modelId = this._requestedModel || (this.env as unknown as Record<string, string>).DEFAULT_AI_MODEL || "";
    return modelId ? AI_MODELS.find((m) => m.id === modelId) : undefined;
  }

  /** Choose model based on provider routing: workers-ai, openai, or anthropic */
  private _getModel() {
    const entry = this._resolveModelEntry();
    const provider = entry?.provider ?? "workers-ai";

    // OpenAI provider
    if (provider === "openai" && this.env.OPENAI_API_KEY) {
      return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(entry!.modelId);
    }

    // Anthropic provider (fallback for any unknown provider)
    if (provider === "anthropic" && this.env.ANTHROPIC_API_KEY) {
      return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(entry!.modelId);
    }

    // Fallback to Anthropic Haiku if model entry not found or API key not available
    return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-haiku-4-5-20251001");
  }

  /** Lazily initialize Langfuse client. Returns null if env vars not configured.
   *  Cached per DO instance (survives across requests until hibernation).
   *
   *  KEY-DECISION 2026-02-19: langfuse v3 (not @langfuse/otel) chosen for CF Workers compat.
   *  @langfuse/otel depends on NodeTracerProvider which uses Node.js APIs blocked in Workers.
   *  langfuse v3 is fetch-based - works in edge runtimes. flushAt:1 + flushInterval:0 ensures
   *  traces flush immediately per request (no background timer accumulating in the DO). */
  private _getLangfuse(): Langfuse | null {
    if (this._langfuseClient !== undefined) return this._langfuseClient as Langfuse | null;
    if (!this.env.LANGFUSE_PUBLIC_KEY || !this.env.LANGFUSE_SECRET_KEY) {
      this._langfuseClient = null;
      return null;
    }
    const client = new Langfuse({
      publicKey: this.env.LANGFUSE_PUBLIC_KEY,
      secretKey: this.env.LANGFUSE_SECRET_KEY,
      baseUrl: this.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
      flushAt: 1,
      flushInterval: 0,
    });
    this._langfuseClient = client;
    console.debug(JSON.stringify({ event: "langfuse:init", boardId: this.name }));
    return client;
  }

  /** Return a traced model for a specific request type.
   *  Wraps the base model with Langfuse tracing middleware that captures
   *  full conversation I/O, token usage, and tool calls for each request. */
  private _getTracedModel(
    trigger: string,
    persona: string,
    options?: { gameMode?: string; scenePhase?: string; intentChip?: string },
  ) {
    return wrapLanguageModel({
      model: this._getModel(),
      middleware: createTracingMiddleware(
        {
          boardId: this.name,
          trigger,
          persona,
          model: this._getModelName(),
          promptVersion: PROMPT_VERSION,
          ...(options?.gameMode && { gameMode: options.gameMode }),
          ...(options?.scenePhase && { scenePhase: options.scenePhase }),
          ...(options?.intentChip && { intentChip: options.intentChip }),
        },
        this._getLangfuse(),
      ),
    });
  }

  /** Model name for logging (avoids exposing full model object) */
  private _getModelName(): string {
    const entry = this._resolveModelEntry();
    if (entry) return entry.id;
    return "claude-haiku-4.5";
  }

  /** Check if current model is an Anthropic model (for budget/neuron tracking) */
  private _isAnthropicModel(): boolean {
    const entry = this._resolveModelEntry();
    return !entry || entry.provider === "anthropic";
  }

  /** Structured log: AI request started */
  private _logRequestStart(trigger: string, persona: string, extra?: Record<string, unknown>) {
    console.debug(
      JSON.stringify({
        event: "ai:request:start",
        boardId: this.name,
        model: this._getModelName(),
        promptVersion: PROMPT_VERSION,
        trigger,
        persona,
        ...extra,
      }),
    );
  }

  /** Structured log: AI request completed with timing/step metrics */
  private _logRequestEnd(
    trigger: string,
    persona: string,
    startTime: number,
    steps: number,
    toolCalls: number,
    extra?: Record<string, unknown>,
  ) {
    // Neuron tracking removed - Workers AI models no longer supported.
    // Anthropic and OpenAI handle billing separately.
    console.debug(
      JSON.stringify({
        event: "ai:request:end",
        boardId: this.name,
        model: this._getModelName(),
        promptVersion: PROMPT_VERSION,
        trigger,
        persona,
        steps,
        toolCalls,
        durationMs: Date.now() - startTime,
        dailyNeurons: this._dailySpendNeurons,
        ...extra,
      }),
    );
  }

  /** Fire-and-forget: record sanitize repair event in Langfuse when weak models emit malformed tool inputs.
   *  KEY-DECISION 2026-02-20: Separate trace (not correlated with generation trace) because sanitize
   *  runs before the AI call. Grouped by model tag so degradation appears as rising metric over time. */
  private _traceSanitizeRepair(trigger: string, repairedCount: number): void {
    const lf = this._getLangfuse();
    if (!lf) return;
    try {
      const trace = lf.trace({
        name: "sanitize:repair",
        metadata: { boardId: this.name, model: this._getModelName(), trigger, repairedCount },
        tags: ["sanitize", `model:${this._getModelName()}`, `trigger:${trigger}`],
      });
      lf.score({ traceId: trace.id, name: "sanitized_messages", value: repairedCount });
      lf.flushAsync().catch((err) => {
        console.error(JSON.stringify({ event: "trace:langfuse-flush-error", boardId: this.name, error: String(err) }));
      });
    } catch (err) {
      console.error(JSON.stringify({ event: "trace:sanitize-error", boardId: this.name, error: String(err) }));
    }
  }

  /** Fire-and-forget: record tool execution failures in Langfuse.
   *  Called after streamText/generateText when any tool returned an error response.
   *  Tool errors here mean Board DO rejected the mutation (object not found, out of bounds, etc.) */
  private _traceToolFailures(
    trigger: string,
    steps: { toolCalls: unknown[]; toolResults?: { toolCallId: string; output: unknown }[] }[],
  ): void {
    const lf = this._getLangfuse();
    if (!lf) return;
    try {
      const failedOutcomes: { toolName: string; error: unknown }[] = [];
      for (const step of steps) {
        for (const tr of step.toolResults ?? []) {
          if (isPlainObject(tr.output) && "error" in tr.output) {
            const toolCall = step.toolCalls.find((tc) => isPlainObject(tc) && tc.toolCallId === tr.toolCallId) as
              | Record<string, unknown>
              | undefined;
            const toolName = typeof toolCall?.toolName === "string" ? toolCall.toolName : "unknown";
            failedOutcomes.push({
              toolName,
              error: tr.output.error,
            });
          }
        }
      }
      if (failedOutcomes.length === 0) return;
      const trace = lf.trace({
        name: "tool:outcome:failed",
        metadata: { boardId: this.name, model: this._getModelName(), trigger, failedTools: failedOutcomes },
        tags: ["tool:failed", `model:${this._getModelName()}`, `trigger:${trigger}`],
      });
      lf.score({ traceId: trace.id, name: "tool_failures", value: failedOutcomes.length });
      lf.flushAsync().catch((err) => {
        console.error(JSON.stringify({ event: "trace:langfuse-flush-error", boardId: this.name, error: String(err) }));
      });
    } catch (err) {
      console.error(JSON.stringify({ event: "trace:tool-outcome-error", boardId: this.name, error: String(err) }));
    }
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>, options?: OnChatMessageOptions) {
    // this.name = boardId (set by client connecting to /agents/ChatAgent/<boardId>)

    // Extract body early - used for rate limiting AND throughout the method.
    // Cast Record<string,unknown> to known shape - client always sends these fields per-message.
    const body = options?.body as
      | {
          username?: string;
          model?: string;
          gameMode?: string;
          personaId?: string;
          intent?: string;
          selectedIds?: string[];
          troupeConfig?: TroupeConfig;
          templateId?: string;
        }
      | undefined;

    // KEY-DECISION 2026-02-19: Rate limit check before _isGenerating mutex -
    // if _checkUserRateLimit throws, mutex won't leak permanently blocking director/reactive.
    // "anonymous" fallback is intentionally a shared bucket (fail-safe direction vs. bypassing limit).
    const userKey = body?.username || "anonymous";
    const rl = this._checkUserRateLimit(userKey);
    if (rl.limited) {
      console.warn(
        JSON.stringify({
          event: "rate-limit:ai",
          boardId: this.name,
          user: userKey,
        }),
      );
      const lf = this._getLangfuse();
      if (lf) {
        lf.trace({
          name: "rate-limit:ai",
          metadata: { boardId: this.name, user: userKey, retryAfter: rl.retryAfter },
          tags: ["rate-limit"],
        });
        lf.flushAsync().catch((err) => {
          console.error(
            JSON.stringify({ event: "trace:langfuse-flush-error", boardId: this.name, error: String(err) }),
          );
        });
      }
      const rlMsg: UIMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [
          {
            type: "text" as const,
            text: `Too many messages! Please slow down - try again in ${rl.retryAfter}s.`,
          },
        ],
      };
      this.messages.push(rlMsg);
      await this.persistMessages(this.messages);
      return new Response(JSON.stringify({ error: "rate-limited" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    this._isGenerating = true;
    this._autonomousExchangeCount = 0; // human spoke - reset cooldown
    this._lastHumanMessageAt = Date.now(); // track for canvas reaction "player is chatting" guard
    const startTime = Date.now();

    const doId = this.env.BOARD.idFromName(this.name);
    const boardStub = this.env.BOARD.get(doId);

    // Extract troupeConfig early - used to gate stage manager and skip SCENE_SETUP_PROMPT
    const troupeConfig =
      body?.troupeConfig && typeof body.troupeConfig === "object" && !Array.isArray(body.troupeConfig)
        ? (body.troupeConfig as TroupeConfig)
        : undefined;

    // KEY-DECISION 2026-02-19: Server-side template seeding. When body.templateId is present,
    // create all template objects via Board DO RPC (guaranteed count), rewrite the user message
    // to displayText, and set a flag so the system prompt injects the template description
    // instead of SCENE_SETUP_PROMPT. This replaced LLM-parsed pseudocode which was unreliable.
    let templateDescription: string | undefined;
    if (body?.templateId) {
      const template = getTemplateById(body.templateId as string);
      if (template) {
        const seedBatchId = crypto.randomUUID();

        // Seed all template objects on the board. Errors are non-fatal: if seeding
        // partially fails, the AI still responds to whatever objects were created.
        try {
          for (const objSpec of template.objects) {
            const obj: BoardObject = {
              ...objSpec,
              id: crypto.randomUUID(),
              createdBy: AI_USER_ID,
              updatedAt: Date.now(),
              batchId: seedBatchId,
            } as BoardObject;
            await boardStub.mutate({ type: "obj:create", obj });
          }
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "template:seed:error",
              boardId: this.name,
              templateId: template.id,
              batchId: seedBatchId,
              error: String(err),
            }),
          );
        }

        console.debug(
          JSON.stringify({
            event: "template:seed",
            boardId: this.name,
            templateId: template.id,
            objectCount: template.objects.length,
            batchId: seedBatchId,
          }),
        );

        // Rewrite the last user message to show displayText instead of raw pseudocode/templateId
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          const userPrefix = body?.username ? `[${body.username}] ` : "";
          this.messages[this.messages.length - 1] = {
            ...lastMsg,
            parts: [{ type: "text" as const, text: `${userPrefix}${template.displayText}` }],
          };
        }

        templateDescription = template.description;
      }
    }

    // Capture previous claim before update to detect tag-out (persona switch mid-scene)
    const previousClaimId =
      body?.personaId && body?.username ? this._personaClaims.get(body.username as string) : undefined;

    // Update persona claim from client (re-sent on every message for hibernation resilience)
    if (body?.personaId && body?.username) {
      this._personaClaims.set(body.username as string, body.personaId as string);
    }

    // Pass troupeConfig override: client sends it every message (hibernation pattern), so this
    // is always current. Avoids ordering issue vs. DO storage write (done later in _runStageManager).
    const personas = await this._getEffectivePersonas(troupeConfig);
    const { activeIndex, activePersona, otherPersona } = this._resolveActivePersona(personas, body?.username);

    // Detect tag-out: player switched from one claimed persona to another mid-scene.
    // previousClaimId undefined = initial claim (first message with personaId), not a switch.
    const tagOutEvent =
      previousClaimId && body?.personaId && previousClaimId !== (body.personaId as string)
        ? (() => {
            const oldPersona = personas.find((p) => p.id === previousClaimId);
            const newPersona = personas.find((p) => p.id === (body.personaId as string));
            return oldPersona && newPersona
              ? { oldPersonaName: oldPersona.name, newPersonaName: newPersona.name }
              : null;
          })()
        : null;
    // Budget enforcement: count human turns (the message just added is already in this.messages)
    const humanTurns = this.messages.filter((m) => m.role === "user").length;
    const budgetPhase = computeBudgetPhase(humanTurns, SCENE_TURN_BUDGET);
    this._logRequestStart("chat", activePersona.name, {
      budgetPhase,
      humanTurns,
    });

    // Daily spend cap removed - Workers AI models no longer supported.
    // Anthropic and OpenAI handle billing through their respective platforms.

    // Reject if scene is over - the last human message pushed us past the budget
    if (humanTurns > SCENE_TURN_BUDGET) {
      this._isGenerating = false;
      console.debug(
        JSON.stringify({
          event: "budget:reject",
          boardId: this.name,
          humanTurns,
          budget: SCENE_TURN_BUDGET,
        }),
      );
      const lf = this._getLangfuse();
      if (lf) {
        lf.trace({
          name: "budget:scene-over",
          metadata: { boardId: this.name, humanTurns, budget: SCENE_TURN_BUDGET },
          tags: ["budget", "scene-over"],
        });
        lf.flushAsync().catch((err) => {
          console.error(
            JSON.stringify({ event: "trace:langfuse-flush-error", boardId: this.name, error: String(err) }),
          );
        });
      }
      // Build a "scene is over" assistant message so the client sees feedback
      const overMsg: UIMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [
          {
            type: "text" as const,
            text: `[${activePersona.name}] Scene's over! That was a great run. Start a new scene to play again.`,
          },
        ],
      };
      this.messages.push(overMsg);
      await this.persistMessages(this.messages);
      return new Response(JSON.stringify({ error: "scene-over" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Record chat activity for async notifications (non-blocking)
    this.ctx.waitUntil(
      recordBoardActivity(this.env.DB, this.name).catch((err: unknown) => {
        console.error(
          JSON.stringify({
            event: "activity:record",
            trigger: "chat",
            error: String(err),
          }),
        );
      }),
    );

    // Generate stage background on first message (non-blocking, parallel with AI response).
    // Skipped when troupeConfig is present - stage manager handles backdrop via generateImage tool.
    if (humanTurns <= 1 && !troupeConfig) {
      const promptText =
        this.messages
          .filter((m) => m.role === "user")
          .at(-1)
          ?.parts?.filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("") ?? "";
      this.ctx.waitUntil(
        this._generateBackground(promptText, boardStub as unknown as BoardStub, templateDescription).catch(
          (err: unknown) => {
            console.error(
              JSON.stringify({
                event: "background:error",
                boardId: this.name,
                error: String(err),
              }),
            );
          },
        ),
      );
    }

    // KEY-DECISION 2026-02-21: main=4, stageManager=3, globalMax=6. Shared budget ref so
    // stageManager + main streamText together respect a single global per-turn cap (~6).
    // Out-of-band calls (reactive, sfx, canvas, director) run in separate execution contexts.
    // KEY-DECISION 2026-02-21: sharedBounds mirrors createBudget pattern - a mutable array ref
    // so stageManager objects are visible to main's flowPlace and vice versa. Fixes overlap=12
    // on grid-2x2 where stageManager + main were placing objects without awareness of each other.
    // Pre-detect qa: prefix so qaMode can be passed to createSDKTools before the main streamText call.
    // Full detection + message rewrite happens below; this is a lightweight read-only check.
    const _lastMsgPrecheck = this.messages[this.messages.length - 1];
    const _lastTextPrecheck =
      _lastMsgPrecheck?.role === "user"
        ? (_lastMsgPrecheck.parts
            ?.filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("") ?? "")
        : "";
    // Strip [username] prefix, then check for qa: (case-insensitive, trimmed)
    const _contentPrecheck = _lastTextPrecheck.replace(/^\[[^\]]+\]\s*/, "");
    const qaMode = /^qa:\s*.+/is.test(_contentPrecheck);

    // KEY-DECISION 2026-02-21: Crisis/escalation turns should use effect tools (highlightObject,
    // play_sfx, advanceScenePhase) rather than flooding the canvas with new objects. Cap creates
    // at 2 (main) and 1 (stageManager) as a server-side backstop for when Haiku ignores the
    // CRISIS EVENTS prompt rule. Detection covers intent chips + freetext keywords.
    const CRISIS_INTENT_CHIPS = ["escalate!", "plot twist!"];
    const CRISIS_KEYWORDS = /escalat|crisis|emergency|fire|disaster|complicat/i;
    const intentChipRaw = typeof body?.intent === "string" ? body.intent.toLowerCase() : "";
    const crisisTrigger =
      CRISIS_INTENT_CHIPS.find((chip) => intentChipRaw.includes(chip)) ??
      (CRISIS_KEYWORDS.test(_contentPrecheck) ? (_contentPrecheck.match(CRISIS_KEYWORDS)?.[0] ?? "keyword") : null);
    const isCrisisTurn = crisisTrigger !== null && !qaMode;
    if (isCrisisTurn) {
      console.log(JSON.stringify({ event: "ai:crisis-cap", maxCreates: 2, trigger: crisisTrigger }));
    }
    const mainMaxCreates = isCrisisTurn ? 2 : 4;
    const stageManagerMaxCreates = isCrisisTurn ? 1 : 3;

    const createBudget: CreateBudget = { used: 0 };
    const sharedBounds: SharedBounds = [];
    const batchId = crypto.randomUUID();
    const tools = createSDKTools(
      boardStub,
      batchId,
      this.env.AI,
      this.ctx.storage,
      mainMaxCreates,
      createBudget,
      6,
      sharedBounds,
      qaMode,
    );

    // Update game mode from client (sent on every message so it survives DO hibernation)
    if (body?.gameMode && ["yesand", "freeform", "harold"].includes(body.gameMode)) {
      this._gameMode = body.gameMode as GameMode;
    }

    // Update requested model from client (sent on every message so it survives DO hibernation)
    if (body?.model && AI_MODELS.some((m) => m.id === body.model)) {
      this._requestedModel = body.model as string;
    }

    // Compute scene phase for tracing context
    const scenePhase = computeScenePhase(humanTurns);
    const intentChip = typeof body?.intent === "string" ? (body.intent as string) : undefined;

    // Track yes-and beat count
    if (this._gameMode === "yesand") {
      this._yesAndCount++;
    }

    const gameModeState: GameModeState = {
      yesAndCount: this._yesAndCount,
      haroldTurns: humanTurns,
    };
    const gameModeBlock = buildGameModePromptBlock(this._gameMode, gameModeState);

    // Clear relationships, lifecycle phase, and plot twist gate at scene start
    if (this.messages.length <= 1) {
      await this.ctx.storage.delete("narrative:relationships");
      await this.ctx.storage.delete("scene:lifecyclePhase");
      this._plotTwistUsed = false;
    }

    // Detect [PLOT TWIST] trigger in the last user message.
    // KEY-DECISION 2026-02-20: Message-text detection (not body.intent) keeps the server as the
    // authority on twist selection - client sends the [PLOT TWIST] signal, server picks the twist.
    const lastUserMsgRaw = this.messages[this.messages.length - 1];
    const lastUserTextRaw =
      lastUserMsgRaw?.parts
        ?.filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("") ?? "";
    let injectedTwist: string | undefined;
    if (lastUserTextRaw.includes("[PLOT TWIST]") && !this._plotTwistUsed) {
      this._plotTwistUsed = true;
      injectedTwist = PLOT_TWISTS[Math.floor(Math.random() * PLOT_TWISTS.length)];
      // Rewrite user message so history shows the actual twist, not the raw marker
      if (lastUserMsgRaw) {
        const userPrefix = body?.username ? `[${body.username}] ` : "";
        this.messages[this.messages.length - 1] = {
          ...lastUserMsgRaw,
          parts: [{ type: "text" as const, text: `${userPrefix}Plot twist: ${injectedTwist}` }],
        };
      }
      console.debug(JSON.stringify({ event: "plot-twist:fired", boardId: this.name, twist: injectedTwist }));
    } else if (lastUserTextRaw.includes("[PLOT TWIST]") && this._plotTwistUsed) {
      // Already used this scene - quietly no-op (client should have disabled the button)
      console.debug(JSON.stringify({ event: "plot-twist:already-used", boardId: this.name }));
    }

    // Detect chat keyword prefixes: "note:" (director notes), "sm:" (stage manager), "qa:" (QA test commands).
    // KEY-DECISION 2026-02-21: Server-side detection rewrites message history with a structured
    // tag so the AI sees clean context rather than raw prefix syntax. Follows [PLOT TWIST] pattern.
    // KEY-DECISION 2026-02-22: sm: checked before qa: so "sm:" is never caught by qa: match.
    let detectedDirectorNote: { username: string; content: string } | undefined;
    let detectedSMCommand: string | undefined;
    let detectedQACommand: string | undefined;
    const lastMsgForPrefix = this.messages[this.messages.length - 1];
    if (lastMsgForPrefix?.role === "user") {
      const rawTextForPrefix =
        lastMsgForPrefix.parts
          ?.filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("") ?? "";
      // Strip [username] prefix before checking for keyword prefixes
      const contentForPrefix = rawTextForPrefix.replace(/^\[[^\]]+\]\s*/, "");
      const noteMatch = contentForPrefix.match(/^note:\s*(.+)/is);
      const smMatch = !noteMatch && contentForPrefix.match(/^sm:\s*(.+)/is);
      const qaMatch = !noteMatch && !smMatch && contentForPrefix.match(/^qa:\s*(.+)/is);
      const uname = (body?.username as string | undefined) || "a player";
      if (noteMatch) {
        const content = noteMatch[1].trim();
        detectedDirectorNote = { username: uname, content };
        this.messages[this.messages.length - 1] = {
          ...lastMsgForPrefix,
          parts: [{ type: "text" as const, text: `[${uname}] [DIRECTOR NOTE: ${content}]` }],
        };
        console.debug(JSON.stringify({ event: "chat:director-note", boardId: this.name, user: uname }));
      } else if (smMatch) {
        const content = smMatch[1].trim();
        detectedSMCommand = content;
        this.messages[this.messages.length - 1] = {
          ...lastMsgForPrefix,
          parts: [{ type: "text" as const, text: `[${uname}] [STAGE DIRECTION: ${content}]` }],
        };
        console.debug(JSON.stringify({ event: "chat:stage-direction", boardId: this.name, user: uname }));
      } else if (qaMatch) {
        const command = qaMatch[1].trim();
        detectedQACommand = command;
        this.messages[this.messages.length - 1] = {
          ...lastMsgForPrefix,
          parts: [{ type: "text" as const, text: `[${uname}] [QA TEST: ${command}]` }],
        };
        console.debug(JSON.stringify({ event: "chat:qa-command", boardId: this.name, user: uname }));
      }
    }

    // Load scene relationships for system prompt injection
    const relationships = (await this.ctx.storage.get<CharacterRelationship[]>("narrative:relationships")) ?? [];
    const relBlock = buildRelationshipBlock(relationships);

    // Load stored lifecycle phase and compute effective phase (more advanced of stored vs auto)
    const storedLifecyclePhase = await this.ctx.storage.get<SceneLifecyclePhase>("scene:lifecyclePhase");
    const lifecyclePhase = computeLifecyclePhase(humanTurns, storedLifecyclePhase ?? undefined);

    // Build persona-aware system prompt with optional selection + multiplayer context
    let systemPrompt = buildPersonaSystemPrompt(activePersona, otherPersona, SYSTEM_PROMPT, gameModeBlock, relBlock);

    systemPrompt += `\n\n${buildLifecycleBlock(lifecyclePhase)}`;

    // Auto-archive on curtain (>=5 human turns to avoid archiving micro-scenes)
    // KEY-DECISION 2026-02-20: ctx.waitUntil so archiving never delays the AI response stream.
    // 5-turn minimum prevents empty boards from appearing in the gallery after a quick curtain call.
    if (lifecyclePhase === "curtain" && humanTurns >= 5) {
      this.ctx.waitUntil(
        boardStub.archiveScene().catch((err: unknown) => {
          console.error(
            JSON.stringify({
              event: "archive:unhandled",
              boardId: this.name,
              error: String(err),
            }),
          );
        }),
      );
      this.ctx.waitUntil(
        this._generateCriticReview(boardStub as unknown as BoardStub).catch((err: unknown) => {
          console.error(
            JSON.stringify({
              event: "critic:unhandled",
              boardId: this.name,
              error: String(err),
            }),
          );
        }),
      );
      // Broadcast curtain call with all scene characters so the client can show the applause overlay.
      const curtainCharacters = personas.map((p) => ({ id: p.id, name: p.name }));
      this.ctx.waitUntil(
        boardStub.broadcastCurtainCall(curtainCharacters).catch((err: unknown) => {
          console.error(
            JSON.stringify({
              event: "curtain-call:unhandled",
              boardId: this.name,
              error: String(err),
            }),
          );
        }),
      );
    }

    // Scene setup: inject template description (if template was seeded) or generic scene structure.
    // Skip SCENE_SETUP_PROMPT when troupeConfig is present - stage manager already set the stage.
    if (templateDescription) {
      systemPrompt += `\n\nSCENE ALREADY SET: The canvas has been populated with the scene. Here's what's there:\n${templateDescription}\nReact to what's on the canvas. Do NOT recreate these objects - they already exist. Riff on the scene in character.`;
    } else if (humanTurns <= 1 && !troupeConfig) {
      systemPrompt += `\n\n${SCENE_SETUP_PROMPT}`;
    }

    // Tag-out: inject theatrical handoff prompt when player switches persona mid-scene
    if (tagOutEvent) {
      const playerName = (body?.username as string | undefined) || "A player";
      systemPrompt += `\n\n${buildTagOutPrompt(tagOutEvent.oldPersonaName, tagOutEvent.newPersonaName, playerName)}`;
      console.debug(
        JSON.stringify({
          event: "chat:tag-out",
          boardId: this.name,
          player: playerName,
          from: tagOutEvent.oldPersonaName,
          to: tagOutEvent.newPersonaName,
        }),
      );
    }

    // Plot twist: inject concrete twist context when the [PLOT TWIST] trigger fired this turn
    if (injectedTwist) {
      systemPrompt += `\n\n${buildPlotTwistPrompt(injectedTwist)}`;
    }

    // Intent-specific guidance: injected only when player clicked a dramatic chip.
    // Runtime type check (body is `any`) before lookup - unknown keys log a warning for
    // debugging version mismatches between client chip labels and INTENT_PROMPTS keys.
    const intentKey = typeof body?.intent === "string" ? (body.intent as string) : undefined;
    if (intentKey && INTENT_PROMPTS[intentKey]) {
      systemPrompt += `\n\n${INTENT_PROMPTS[intentKey]}`;
    } else if (intentKey) {
      console.warn(JSON.stringify({ event: "chat:unknown-intent", boardId: this.name, intent: intentKey }));
    }

    // Inject budget phase prompt when not in normal phase
    if (budgetPhase !== "normal") {
      systemPrompt += `\n\n${BUDGET_PROMPTS[budgetPhase]}`;
    }

    // Heckler mode: drain pending audience heckles and inject as context
    if (this._pendingHeckles.length > 0) {
      const heckles = this._pendingHeckles;
      this._pendingHeckles = [];
      systemPrompt += `\n\n${buildHecklePrompt(heckles)}`;
    }

    // Audience wave: inject atmospheric crowd energy context on the next response
    if (this._pendingWavePrompts.length > 0) {
      const wavePrompt = this._pendingWavePrompts[this._pendingWavePrompts.length - 1]; // most recent wave
      this._pendingWavePrompts = [];
      systemPrompt += `\n\n${wavePrompt}`;
    }

    // Audience poll result: inject winning choice so AI incorporates it into next scene beat
    if (this._pendingPollResult) {
      const pollResult = this._pendingPollResult;
      this._pendingPollResult = null;
      systemPrompt += `\n\n${buildPollResultPrompt(pollResult)}`;
    }

    // Director note: inject out-of-character guidance so AI adjusts performance without scene dialogue
    if (detectedDirectorNote) {
      systemPrompt += `\n\n${buildDirectorNotePrompt(detectedDirectorNote.username, detectedDirectorNote.content)}`;
    }

    // QA test command: inject direct tool execution instruction
    if (detectedQACommand) {
      systemPrompt += `\n\n${buildQACommandPrompt(detectedQACommand)}`;
    }

    // Momentum nudge: after 3+ exchanges, prompt AI to end with a provocative hook.
    // Skip for QA commands - those should stay focused on tool execution.
    if (humanTurns >= 3 && budgetPhase === "normal" && !detectedQACommand) {
      systemPrompt += `\n\n${MOMENTUM_PROMPT}`;
    }

    // Multiplayer attribution: tell the AI who is speaking
    if (body?.username) {
      systemPrompt += `\n\nThis is a multiplayer board. Messages from users are prefixed with [username]. The current speaker is ${body.username}. Address users by name when relevant.`;
    }

    if (body?.selectedIds?.length) {
      const selectedIds = body.selectedIds;
      const objects = await boardStub.readObjects();
      const selected = (objects as BoardObject[]).filter((o: BoardObject) => selectedIds.includes(o.id));
      if (selected.length > 0) {
        const desc = selected
          .map(
            (o: BoardObject) =>
              `- ${o.type} (id: ${o.id}${(o.props as BoardObjectProps).text ? `, text: "${(o.props as BoardObjectProps).text}"` : ""})`,
          )
          .join("\n");
        systemPrompt += `\n\nThe user has selected ${selected.length} object(s) on the board:\n${desc}\nWhen the user refers to "selected", "these", or "this", they mean the above objects. Use their IDs directly.`;
      }
    }

    // Show AI in presence bar while responding (best-effort, never blocks AI response)
    await boardStub.setAiPresence(true).catch((err: unknown) => {
      console.debug(
        JSON.stringify({
          event: "ai:presence:start-error",
          error: String(err),
        }),
      );
    });

    let presenceCleared = false;
    const clearPresence = async () => {
      if (presenceCleared) return;
      presenceCleared = true;
      try {
        await boardStub.setAiPresence(false);
      } catch (err) {
        console.debug(
          JSON.stringify({
            event: "ai:presence:cleanup-error",
            error: String(err),
          }),
        );
      }
    };

    const wrappedOnFinish: typeof onFinish = async (...args: Parameters<typeof onFinish>) => {
      this._isGenerating = false;
      await clearPresence();

      // Request-level metrics from onFinish
      const finishArg = args[0] as
        | {
            steps?: { toolCalls?: unknown[]; toolResults?: { toolCallId: string; output: unknown }[] }[];
          }
        | undefined;
      const steps = finishArg?.steps?.length ?? 0;
      const toolCalls =
        finishArg?.steps?.reduce((sum: number, s: { toolCalls?: unknown[] }) => sum + (s.toolCalls?.length ?? 0), 0) ??
        0;
      this._logRequestEnd("chat", activePersona.name, startTime, steps, toolCalls);
      // StepResult<T> toolCalls are narrowly typed; _traceToolFailures accepts the common shape
      this._traceToolFailures("chat", (finishArg?.steps ?? []) as any[]);

      // Quality telemetry: per-response layout scoring for prompt tuning
      // Canvas bounds mirror LAYOUT RULES in prompts.ts: (50,60) to (1150,780)
      if (toolCalls > 0) {
        try {
          const allObjects: BoardObject[] = await boardStub.readObjects();
          const batchObjs = allObjects.filter((o) => o.batchId === batchId);

          // Warn if tools were called but no objects matched this batchId -
          // could indicate a timing/persistence issue rather than a real "zero objects" result
          if (batchObjs.length === 0) {
            console.warn(
              JSON.stringify({
                event: "ai:quality:empty-batch",
                boardId: this.name,
                batchId,
                toolCalls,
                totalObjects: allObjects.length,
              }),
            );
          } else {
            const otherObjs = allObjects.filter((o) => o.batchId !== batchId);

            let batchOverlap = 0;
            for (let i = 0; i < batchObjs.length; i++)
              for (let j = i + 1; j < batchObjs.length; j++)
                if (rectsOverlap(batchObjs[i], batchObjs[j])) batchOverlap++;

            let crossOverlap = 0;
            for (const newObj of batchObjs)
              for (const oldObj of otherObjs) if (rectsOverlap(newObj, oldObj)) crossOverlap++;

            const inBounds = batchObjs.filter(
              (o) =>
                o.x >= CANVAS_MIN_X &&
                o.y >= CANVAS_MIN_Y &&
                o.x + o.width <= CANVAS_MAX_X &&
                o.y + o.height <= CANVAS_MAX_Y,
            ).length;

            console.debug(
              JSON.stringify({
                event: "ai:quality",
                promptVersion: PROMPT_VERSION,
                batchOverlap,
                crossOverlap,
                objectsCreated: batchObjs.length,
                inBounds,
                model: this._getModelName(),
              }),
            );
          }
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "ai:quality:error",
              boardId: this.name,
              batchId,
              error: String(err),
              stack: err instanceof Error ? err.stack : undefined,
            }),
          );
        }
      }

      // Ensure active persona's message has the [NAME] prefix (LLMs sometimes forget)
      this._ensurePersonaPrefix(activePersona.name);

      // Enforce game mode rules (e.g. Yes-And prefix) after persona prefix is in place
      this._enforceGameModeRules(activePersona.name);

      // Sanitize AI output against content blocklist before persisting
      this._moderateLastMessage();

      // Auto-name the board from scene content on 3rd human turn
      if (humanTurns === 3) {
        this.ctx.waitUntil(
          this._generateBoardName(boardStub as unknown as BoardStub).catch((err: unknown) => {
            console.error(
              JSON.stringify({
                event: "board:name:unhandled",
                boardId: this.name,
                error: String(err),
              }),
            );
          }),
        );
      }

      // Trigger reactive persona to "yes, and" the active persona's response.
      // Pass crisis-aware maxCreates so reactive doesn't bypass the turn's create budget.
      const reactiveMaxCreates = isCrisisTurn ? 1 : 2;
      this.ctx.waitUntil(
        this._triggerReactivePersona(activeIndex, personas, reactiveMaxCreates).catch((err: unknown) => {
          console.error(
            JSON.stringify({
              event: "reactive:unhandled",
              boardId: this.name,
              error: String(err),
            }),
          );
        }),
      );

      // Per-turn quality signal: score 4 improv dimensions via Haiku judge (after reactive persona)
      if (String(this.env.QUALITY_SIGNAL_ENABLED) === "true") {
        const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
        const lastAiMsg = [...this.messages].reverse().find((m) => m.role === "assistant");
        const userMsgText =
          lastUserMsg?.parts
            ?.filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("") ?? "";
        const aiMsgText =
          lastAiMsg?.parts
            ?.filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("") ?? "";
        const toolCallNames: string[] =
          (finishArg?.steps as any[])?.flatMap((s: any) =>
            (s.toolCalls ?? []).map((tc: any) => tc.toolName ?? "unknown"),
          ) ?? [];
        this.ctx.waitUntil(
          this._scoreQualitySignal(userMsgText, aiMsgText, toolCallNames, personas).catch((err: unknown) => {
            console.warn(JSON.stringify({ event: "quality-signal:unhandled", boardId: this.name, error: String(err) }));
          }),
        );
      }

      return onFinish(...args);
    };

    // Clean up presence if client disconnects mid-stream
    options?.abortSignal?.addEventListener(
      "abort",
      () => {
        this._isGenerating = false;
        clearPresence();
      },
      { once: true },
    );

    // Reset the director inactivity timer on every user message
    this._resetDirectorTimer();

    try {
      // SM: prefix - invoke stage manager on demand, skip main streamText entirely.
      // Stage manager is silent (generateText only) - no chat output, no reactive persona.
      // KEY-DECISION 2026-02-22: Falls back to default SPARK+SAGE troupe when no troupeConfig
      // is stored, so sm: works on any board even without the onboard wizard.
      if (detectedSMCommand) {
        const storedTroupeConfig = troupeConfig ?? (await this.ctx.storage.get<TroupeConfig>("troupeConfig"));
        const effectiveConfig: TroupeConfig = storedTroupeConfig ?? {
          members: personas.slice(0, 2).map((p) => ({ personaId: p.id, model: "claude-haiku-4.5" as AIModel })),
        };
        await this._runStageManager(
          effectiveConfig,
          boardStub as unknown as BoardStub,
          detectedSMCommand,
          personas,
          createBudget,
          sharedBounds,
          false, // qaMode: SM: never bypasses caps
          stageManagerMaxCreates,
          this._getLangfuse(),
        );
        this._isGenerating = false;
        await clearPresence();
        return new Response(null, { status: 204 });
      }

      // Stage Manager: synchronous scene setup on first exchange when troupe is configured.
      // Awaited so the canvas is populated before the main streamText response begins streaming.
      if (humanTurns <= 1 && troupeConfig) {
        const sceneOpener =
          this.messages
            .filter((m) => m.role === "user")
            .at(-1)
            ?.parts?.filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("") ?? "";
        await this._runStageManager(
          troupeConfig,
          boardStub as unknown as BoardStub,
          sceneOpener,
          personas,
          createBudget,
          sharedBounds,
          qaMode,
          stageManagerMaxCreates,
          this._getLangfuse(),
        );
        // KEY-DECISION 2026-02-23: backdrop fallback ensures every board gets an isBackground image
        // even when SM skips generateImage. _generateBackground has a duplicate guard so this is safe.
        this.ctx.waitUntil(
          this._generateBackground(sceneOpener, boardStub as unknown as BoardStub, templateDescription).catch(
            (err: unknown) => {
              console.error(
                JSON.stringify({
                  event: "background:fallback-error",
                  boardId: this.name,
                  error: String(err),
                }),
              );
            },
          ),
        );
      }

      // Inject compact board state summary so the AI knows what's on canvas without a getBoardState tool call.
      // KEY-DECISION 2026-02-22: Injected after stage manager so SM-placed objects are visible.
      // Fires every turn (not just turn 1) - keeps the AI grounded on dense boards.
      // Lines and background images excluded: lines are positional noise, backgrounds are decorative.
      try {
        const boardObjects = (await boardStub.readObjects()) as BoardObject[];
        const visible = boardObjects.filter((o) => !o.isBackground && o.type !== "line");
        let stageBlock: string;
        if (visible.length === 0) {
          stageBlock = "[CURRENT STAGE]\nEmpty canvas.";
        } else {
          const descs = visible.map((o) => {
            const p = o.props as BoardObjectProps;
            const name = p.text || p.prompt || "";
            const color = p.color || p.fill || "";
            const parts: string[] = [o.type];
            if (name) parts.push(`"${name}"`);
            parts.push(`(id:${o.id.slice(0, 6)})`);
            if (color) parts.push(color);
            return parts.join(" ");
          });
          stageBlock = `[CURRENT STAGE]\nObjects on canvas: ${descs.join(", ")}`;
        }
        systemPrompt += `\n\n${stageBlock}`;
      } catch (err) {
        console.warn(JSON.stringify({ event: "board-state-inject:error", boardId: this.name, error: String(err) }));
        // Non-fatal: skip injection if board state read fails
      }

      const { messages: sanitizedMsgs, repairedCount } = sanitizeMessages(this.messages);
      if (repairedCount > 0) this._traceSanitizeRepair("chat", repairedCount);
      const result = streamText({
        model: this._getTracedModel("chat", activePersona.name, {
          gameMode: this._gameMode,
          scenePhase,
          intentChip,
        }),
        system: systemPrompt,
        messages: await convertToModelMessages(sanitizedMsgs),
        tools,
        // base class declares ToolSet; streamText sees specific tool types (variance mismatch, runtime-safe)
        onFinish: wrappedOnFinish as any,
        stopWhen: stepCountIs(5),
        abortSignal: options?.abortSignal,
      });

      return result.toUIMessageStreamResponse();
    } catch (err) {
      this._isGenerating = false;
      await clearPresence();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Stage background generation (non-blocking, fire-and-forget via ctx.waitUntil)
  // ---------------------------------------------------------------------------

  /** Generate a theatrical backdrop image and place it on the canvas.
   *  Called via ctx.waitUntil on the first human message - never blocks the AI response.
   *  Canvas bounds from prompts.ts LAYOUT RULES: (50,60) to (1150,780). */
  private async _generateBackground(
    userPrompt: string,
    boardStub: BoardStub,
    templateDescription?: string,
  ): Promise<void> {
    // Guard: check for existing background to prevent duplicates (page refresh / reconnect)
    const existingObjects = await boardStub.readObjects();
    if (existingObjects.some((o: BoardObject) => o.isBackground)) {
      console.debug(JSON.stringify({ event: "background:skip", reason: "exists", boardId: this.name }));
      return;
    }

    // Derive backdrop prompt: use template description when available, otherwise user's message
    const sceneContext = templateDescription || userPrompt;
    const imagePrompt = `stage backdrop, theatrical, wide establishing shot, painterly style: ${sceneContext}`;

    const src = await generateImageDataUrl(this.env.AI, imagePrompt);

    const obj: BoardObject = {
      id: crypto.randomUUID(),
      type: "image",
      isBackground: true,
      x: 50,
      y: 60,
      width: 1100,
      height: 720,
      rotation: 0,
      props: { src, prompt: imagePrompt },
      createdBy: AI_USER_ID,
      updatedAt: Date.now(),
    } as BoardObject;

    await boardStub.mutate({ type: "obj:create", obj });

    console.debug(
      JSON.stringify({
        event: "background:created",
        boardId: this.name,
        id: obj.id,
        promptLen: imagePrompt.length,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Stage Manager (synchronous pre-flight on first exchange with troupeConfig)
  // ---------------------------------------------------------------------------

  /** Set up the canvas before the first player exchange using the Stage Manager persona.
   *  Called synchronously (awaited) so the stage exists when the main response is streaming.
   *  Uses generateText (not streamText) - no output goes to chat history.
   *  KEY-DECISION 2026-02-21: ~3-5s latency on first exchange is acceptable for scene start.
   *  Separate system prompt (not an injection) because the stage manager is a silent technician,
   *  not an improv character - it must not produce chat text. */
  private async _runStageManager(
    troupeConfig: TroupeConfig,
    boardStub: BoardStub,
    sceneOpener: string,
    personas: Persona[],
    createBudget?: CreateBudget,
    sharedBounds?: SharedBounds,
    qaMode = false,
    maxCreates = 3,
    langfuse?: Langfuse | null,
  ): Promise<void> {
    // Persist for troupe-aware persona rotation on subsequent messages (survives DO hibernation)
    await this.ctx.storage.put("troupeConfig", troupeConfig);

    const startTime = Date.now();
    this._logRequestStart("stage-manager", "StageManager");

    // Build persona placement guidance: display names + colors so stage manager places correct characters
    const troupeDescription = troupeConfig.members
      .map((m) => {
        const persona = personas.find((p) => p.id === m.personaId);
        const displayName = m.nickname || persona?.name || m.personaId;
        const color = persona?.color || "#ffffff";
        return `${displayName} (color: ${color})`;
      })
      .join("\n");

    const stageManagerSystem = buildStageManagerPrompt(sceneOpener, troupeDescription);

    // Model selection: stageManagerModel if specified, else fall through to current _getModel()
    let model = this._getModel();
    const stageManagerModelId = troupeConfig.stageManagerModel ?? this._getModelName();
    if (troupeConfig.stageManagerModel) {
      const entry = AI_MODELS.find((m) => m.id === troupeConfig.stageManagerModel);
      if (entry) {
        if (entry.provider === "openai" && this.env.OPENAI_API_KEY) {
          model = createOpenAI({ apiKey: this.env.OPENAI_API_KEY })(entry.modelId);
        } else if (entry.provider === "anthropic" && this.env.ANTHROPIC_API_KEY) {
          model = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(entry.modelId);
        }
        // workers-ai: fall through to _getModel() which already handles workers-ai models
      }
    }
    if (langfuse) {
      model = wrapLanguageModel({
        model,
        middleware: createTracingMiddleware(
          {
            boardId: this.name,
            trigger: "stage-manager",
            persona: "StageManager",
            model: stageManagerModelId,
            promptVersion: PROMPT_VERSION,
          },
          langfuse,
        ),
      });
    }

    const batchId = crypto.randomUUID();
    const tools = createSDKTools(
      boardStub,
      batchId,
      this.env.AI,
      this.ctx.storage,
      maxCreates,
      createBudget,
      6,
      sharedBounds,
      qaMode,
    );

    try {
      const result = await generateText({
        model,
        system: stageManagerSystem,
        // Pass only the scene opener - stage manager is a standalone setup call, not a chat continuation
        messages: [{ role: "user" as const, content: sceneOpener }],
        tools,
        stopWhen: stepCountIs(6),
      });

      const totalToolCalls = result.steps.reduce((sum, s) => sum + s.toolCalls.length, 0);
      this._logRequestEnd("stage-manager", "StageManager", startTime, result.steps.length, totalToolCalls);
      console.debug(
        JSON.stringify({
          event: "stage-manager:complete",
          boardId: this.name,
          toolCalls: totalToolCalls,
          durationMs: Date.now() - startTime,
        }),
      );
    } catch (err) {
      // Non-fatal: stage setup failure doesn't block the main response
      console.error(
        JSON.stringify({
          event: "stage-manager:error",
          boardId: this.name,
          error: String(err),
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Auto board naming (fires once on 3rd human turn via ctx.waitUntil)
  // ---------------------------------------------------------------------------

  /** Generate a creative board name from scene content and update D1.
   *  Fires once via ctx.waitUntil - never blocks the AI response stream.
   *
   *  KEY-DECISION 2026-02-20: meta:autoNamed DO Storage flag prevents re-run after DO hibernation.
   *  WHERE name = 'Untitled Board' guard means user-renamed boards are never overwritten.
   *  Claude Haiku used for naming quality; Workers AI fallback when ANTHROPIC_API_KEY absent. */
  private async _generateBoardName(boardStub: BoardStub): Promise<void> {
    // Guard: only name once per board lifetime
    const alreadyNamed = await this.ctx.storage.get<boolean>("meta:autoNamed");
    if (alreadyNamed) return;
    // Set flag immediately to prevent concurrent runs from a second message arriving
    await this.ctx.storage.put("meta:autoNamed", true);

    // Gather first 3 human messages with [username] prefixes stripped
    const humanTexts = this.messages
      .filter((m) => m.role === "user")
      .slice(0, 3)
      .map((m) => {
        const text =
          m.parts
            ?.filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("") ?? "";
        return text.replace(/^\[[^\]]+\]\s*/, ""); // strip [username] prefix
      })
      .filter((t) => t.length > 0);

    if (humanTexts.length === 0) return;

    // Canvas text: sticky notes and frame titles for scene context
    let canvasTexts: string[] = [];
    try {
      const objects = await boardStub.readObjects();
      canvasTexts = objects
        .filter((o) => (o.type === "sticky" || o.type === "frame") && !o.isBackground)
        .map((o) => (o.props as BoardObjectProps).text || "")
        .filter((t) => t.length > 0)
        .slice(0, 10);
    } catch {
      // canvas read failure - proceed without canvas context
    }

    const sceneLines = [
      `Game mode: ${this._gameMode}`,
      `Players said:\n${humanTexts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
      canvasTexts.length > 0 ? `Canvas: ${canvasTexts.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Cap context at 600 chars to keep naming cheap
    const namingPrompt =
      `You name improv comedy scenes. Given this scene:\n${sceneLines.slice(0, 600)}\n\n` +
      `Write ONE title (max 5 words) that:\n` +
      `- Captures THIS scene's specific absurd collision\n` +
      `- Sounds like an improv episode: "The Dentist's Garlic Problem", "Vampires Need Therapy Too"\n` +
      `- Never uses: Board, Session, Untitled, Collaborative, Improv, Scene\n` +
      `- Is funny or intriguing\n\n` +
      `Title only. No quotes. No explanation.`;

    let rawName = "";
    try {
      if (this.env.ANTHROPIC_API_KEY) {
        // Claude Haiku: cheap, much better at creative naming than Workers AI
        const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
        const result = await generateText({
          model: anthropic(AI_MODELS.find((m) => m.id === "claude-haiku-4.5")!.modelId),
          messages: [{ role: "user" as const, content: namingPrompt }],
        });
        rawName = result.text;
      } else {
        // Fallback to Anthropic if no API key found (shouldn't happen in production)
        const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
        const result = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          messages: [{ role: "user" as const, content: namingPrompt }],
        });
        rawName = result.text;
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "board:name:gen-error", boardId: this.name, error: String(err) }));
      return;
    }

    // Sanitize: strip wrapping quotes, enforce max 8 words
    const boardName = rawName
      .trim()
      .replace(/^["']|["']$/g, "")
      .split(/\s+/)
      .slice(0, 8)
      .join(" ")
      .trim();

    if (!boardName) return;

    try {
      await this.env.DB.prepare(
        "UPDATE boards SET name = ?, updated_at = datetime('now') WHERE id = ? AND name = 'Untitled Board'",
      )
        .bind(boardName, this.name)
        .run();
      console.debug(JSON.stringify({ event: "board:named", boardId: this.name, name: boardName }));
    } catch (err) {
      console.error(JSON.stringify({ event: "board:name:db-error", boardId: this.name, error: String(err) }));
    }
  }

  // ---------------------------------------------------------------------------
  // AI Critic Review (fires once at curtain phase via ctx.waitUntil)
  // ---------------------------------------------------------------------------

  /** Generate a witty 1-5 star critic review from the scene transcript and persist to D1.
   *  Fires once via ctx.waitUntil - never blocks the AI response stream.
   *
   *  KEY-DECISION 2026-02-20: meta:criticReviewed DO Storage flag prevents re-run after hibernation.
   *  Claude Haiku used for review quality; Workers AI fallback when ANTHROPIC_API_KEY absent.
   *  Transcript capped at 2000 chars to keep the call cheap; strips [PERSONA] prefixes so the
   *  critic sees clean dialogue, not protocol noise. */
  private async _generateCriticReview(boardStub: BoardStub): Promise<void> {
    // Guard: only review once per board lifetime
    const alreadyReviewed = await this.ctx.storage.get<boolean>("meta:criticReviewed");
    if (alreadyReviewed) return;
    await this.ctx.storage.put("meta:criticReviewed", true);

    // Extract transcript: human + assistant text, strip [PERSONA] prefixes
    const transcriptLines: string[] = [];
    for (const msg of this.messages) {
      const textParts = msg.parts?.filter((p) => p.type === "text") ?? [];
      for (const p of textParts) {
        const text = (p as { type: "text"; text: string }).text
          .replace(/^\[([^\]]+)\]\s*/, "") // strip [PERSONA] prefix
          .trim();
        if (text) transcriptLines.push(`${msg.role === "user" ? "Player" : "AI"}: ${text}`);
      }
    }

    if (transcriptLines.length === 0) return;

    // Cap transcript to keep the review call cheap
    const fullTranscript = transcriptLines.join("\n");
    const transcript = fullTranscript.length > 2000 ? fullTranscript.slice(0, 2000) + "..." : fullTranscript;

    const reviewPrompt = `${CRITIC_PROMPT}\n\nSCENE TRANSCRIPT:\n${transcript}`;

    let rawResponse = "";
    let modelName = "";
    try {
      if (this.env.ANTHROPIC_API_KEY) {
        const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
        const result = await generateText({
          model: anthropic(AI_MODELS.find((m) => m.id === "claude-haiku-4.5")!.modelId),
          messages: [{ role: "user" as const, content: reviewPrompt }],
        });
        rawResponse = result.text;
        modelName = "claude-haiku-4.5";
      } else {
        // Fallback to Anthropic if no API key found (shouldn't happen in production)
        const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
        const result = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          messages: [{ role: "user" as const, content: reviewPrompt }],
        });
        rawResponse = result.text;
        modelName = "claude-haiku-4.5";
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "critic:gen-error", boardId: this.name, error: String(err) }));
      return;
    }

    // Parse SCORE: [1-5] and REVIEW: [text] from response
    const scoreMatch = rawResponse.match(/SCORE:\s*([1-5])/);
    const reviewMatch = rawResponse.match(/REVIEW:\s*(.+?)(?:\n|$)/s);

    if (!scoreMatch || !reviewMatch) {
      console.warn(JSON.stringify({ event: "critic:parse-fail", boardId: this.name, raw: rawResponse.slice(0, 200) }));
      return;
    }

    const score = parseInt(scoreMatch[1], 10);
    const review = reviewMatch[1].trim();

    if (!review) return;

    // Persist via Board DO RPC (same pattern as archiveScene)
    try {
      await boardStub.saveCriticReview(review, score, modelName);
      console.debug(JSON.stringify({ event: "critic:saved", boardId: this.name, score, model: modelName }));
    } catch (err) {
      console.error(JSON.stringify({ event: "critic:save-error", boardId: this.name, error: String(err) }));
    }
  }

  // ---------------------------------------------------------------------------
  // Per-turn quality signal (fires via ctx.waitUntil after reactive persona)
  // ---------------------------------------------------------------------------

  /** Score the current turn on 4 improv dimensions using a Haiku judge call.
   *  Silent failure - never affects user experience.
   *  Gated by QUALITY_SIGNAL_ENABLED env var (off by default). */
  private async _scoreQualitySignal(
    userMessage: string,
    aiResponse: string,
    toolCallNames: string[],
    personas: Persona[],
  ): Promise<void> {
    if (!this.env.ANTHROPIC_API_KEY) return;

    const prompt = buildQualitySignalPrompt({
      userMessage,
      aiResponse,
      toolCalls: toolCallNames,
      personas: personas.map((p) => p.name),
      gameMode: this._gameMode ?? "freeform",
    });

    let rawResponse: unknown;
    try {
      const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const result = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        messages: [{ role: "user" as const, content: prompt }],
      });
      rawResponse = JSON.parse(result.text);
    } catch (err) {
      console.warn(JSON.stringify({ event: "quality-signal:error", boardId: this.name, error: String(err) }));
      return;
    }

    // Extract ONLY numeric scores, discarding reasoning field to prevent PII leak
    const dims = ["yesAnd", "characterConsistency", "sceneAdvancement", "toolAppropriateness"] as const;
    const scores: Record<string, number> = {};
    const allValid = dims.every((d) => {
      const val = (rawResponse as Record<string, unknown>)?.[d];
      if (typeof val === "number" && val >= 0 && val <= 3) {
        scores[d] = val;
        return true;
      }
      return false;
    });
    if (!allValid) {
      console.warn(
        JSON.stringify({
          event: "quality-signal:invalid",
          boardId: this.name,
          raw: {
            yesAnd: scores["yesAnd"],
            characterConsistency: scores["characterConsistency"],
            sceneAdvancement: scores["sceneAdvancement"],
            toolAppropriateness: scores["toolAppropriateness"],
          },
        }),
      );
      return;
    }

    const total = dims.reduce((sum, d) => sum + scores[d], 0);
    console.debug(
      JSON.stringify({
        event: "ai:quality-signal",
        boardId: this.name,
        promptVersion: PROMPT_VERSION,
        gameMode: this._gameMode,
        yesAnd: scores["yesAnd"],
        characterConsistency: scores["characterConsistency"],
        sceneAdvancement: scores["sceneAdvancement"],
        toolAppropriateness: scores["toolAppropriateness"],
        total,
      }),
    );

    // Push scores to Langfuse if configured
    const lf = this._getLangfuse();
    if (lf) {
      try {
        const traceId = `quality-signal:${this.name}:${Date.now()}`;
        const trace = lf.trace({
          name: "quality-signal",
          metadata: { boardId: this.name, promptVersion: PROMPT_VERSION, gameMode: this._gameMode },
          tags: ["quality-signal"],
        });
        dims.forEach((dim) => {
          trace.score({ name: dim, value: scores[dim], dataType: "NUMERIC" });
        });
        lf.flushAsync().catch((err: unknown) => {
          console.warn(
            JSON.stringify({ event: "quality-signal:langfuse-flush-error", boardId: this.name, error: String(err) }),
          );
        });
      } catch (err) {
        console.warn(
          JSON.stringify({ event: "quality-signal:langfuse-error", boardId: this.name, error: String(err) }),
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Mutex helper
  // ---------------------------------------------------------------------------

  /** Claim the _isGenerating mutex for the duration of fn(), releasing it in a
   *  finally block regardless of how fn() exits (return, throw, or early return). */
  private async withGenerating<T>(fn: () => Promise<T>): Promise<T> {
    this._isGenerating = true;
    try {
      return await fn();
    } finally {
      this._isGenerating = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-agent persona helpers
  // ---------------------------------------------------------------------------

  /** Ensure the last assistant message starts with [PERSONA_NAME] prefix.
   *  Only checks/patches the FIRST text part - patching all parts causes [NAME] to appear
   *  mid-text when multi-step streamText produces text before AND after tool calls.
   *  Uses immutable update + persist to avoid mutating SDK-owned objects. */
  private _ensurePersonaPrefix(personaName: string) {
    const lastMsg = this.messages[this.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    // Only check the first text part to avoid false positives on subsequent parts (e.g. "Done!")
    const firstTextPart = lastMsg.parts.find((p) => p.type === "text");
    if (!firstTextPart) {
      console.warn(
        JSON.stringify({
          event: "persona:prefix:no-text-part",
          boardId: this.name,
          persona: personaName,
        }),
      );
      return;
    }
    // Clean think/tool_call leaks from raw text and strip any wrong-persona prefix before checking
    const cleanedFirst = cleanModelOutput(firstTextPart.text).replace(/^\[([^\]]+)\]\s*/, (match, name) =>
      name === personaName ? match : "",
    );
    // Guard: if cleaning wiped the entire text (LLM emitted only reasoning, no visible content),
    // skip patching - a "[PERSONA] " placeholder is worse than leaving the message as-is.
    if (!cleanedFirst) return;
    const needsFix = !cleanedFirst.startsWith(`[${personaName}]`);
    if (!needsFix && cleanedFirst === firstTextPart.text) return; // text unchanged, nothing to do

    // Only prefix the first text part - leave subsequent parts (e.g. "Done!") untouched
    let patched = false;
    const newParts = lastMsg.parts.map((part) => {
      if (!patched && part.type === "text") {
        patched = true;
        const finalText = needsFix ? `[${personaName}] ${cleanedFirst}` : cleanedFirst;
        return { ...part, text: finalText };
      }
      return part;
    });
    this.messages[this.messages.length - 1] = { ...lastMsg, parts: newParts };
    this.ctx.waitUntil(
      this.persistMessages(this.messages).catch((err: unknown) => {
        console.error(
          JSON.stringify({
            event: "persona:prefix:persist-error",
            boardId: this.name,
            error: String(err),
          }),
        );
      }),
    );
  }

  /** Enforce game mode rules on the last assistant message via post-processing.
   *  For Yes-And Chain mode: prepend "Yes, and " after the persona prefix if missing.
   *  Runs after _ensurePersonaPrefix so the prefix is already in place. */
  private _enforceGameModeRules(personaName: string) {
    if (this._gameMode !== "yesand") return;

    const lastMsg = this.messages[this.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const firstTextPart = lastMsg.parts.find((p) => p.type === "text");
    if (!firstTextPart) return;

    // After persona prefix, check if the response starts with "Yes, and" (case-insensitive)
    const prefix = `[${personaName}] `;
    const textAfterPrefix = firstTextPart.text.startsWith(prefix)
      ? firstTextPart.text.slice(prefix.length)
      : firstTextPart.text;

    if (/^yes,?\s+and/i.test(textAfterPrefix)) return; // already correct

    // Prepend "Yes, and " after the persona prefix
    const newText = firstTextPart.text.startsWith(prefix)
      ? `${prefix}Yes, and ${textAfterPrefix}`
      : `Yes, and ${firstTextPart.text}`;

    let patched = false;
    const newParts = lastMsg.parts.map((part) => {
      if (!patched && part.type === "text") {
        patched = true;
        return { ...part, text: newText };
      }
      return part;
    });
    this.messages[this.messages.length - 1] = { ...lastMsg, parts: newParts };
    this.ctx.waitUntil(
      this.persistMessages(this.messages).catch((err: unknown) => {
        console.error(
          JSON.stringify({
            event: "game-mode-rules:persist-error",
            boardId: this.name,
            error: String(err),
          }),
        );
      }),
    );
  }

  /** Moderate the last assistant message against the content blocklist (streaming/chat path).
   *  Runs after _ensurePersonaPrefix and _enforceGameModeRules - mutates in-place and persists. */
  private _moderateLastMessage() {
    const lastMsg = this.messages[this.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const firstTextPart = lastMsg.parts.find((p) => p.type === "text");
    if (!firstTextPart) return;

    const moderated = moderateOutput(this.name, firstTextPart.text);
    if (moderated === firstTextPart.text) return; // no change - skip persist

    const newParts = lastMsg.parts.map((part) => (part === firstTextPart ? { ...part, text: moderated } : part));
    this.messages[this.messages.length - 1] = { ...lastMsg, parts: newParts };
    this.ctx.waitUntil(
      this.persistMessages(this.messages).catch((err: unknown) => {
        console.error(JSON.stringify({ event: "moderation:persist-error", boardId: this.name, error: String(err) }));
      }),
    );
  }

  /** Build a UIMessage from a generateText result with tool-call parts and persona-prefixed text.
   *  Returns null if the result produced no parts (no tools called, no text). */
  private _buildGenerateTextMessage(
    result: {
      text: string;
      steps: {
        // toolCalls use AI SDK generics; narrowing here would require re-exporting internal SDK types
        toolCalls: any[];
        toolResults: { toolCallId: string; output: unknown }[];
      }[];
    },
    personaName: string,
    fallbackText?: string,
  ): UIMessage | null {
    const parts: UIMessage["parts"] = [];

    for (const step of result.steps) {
      for (const tc of step.toolCalls) {
        const tr = step.toolResults.find((r: { toolCallId: string }) => r.toolCallId === tc.toolCallId);
        const safeInput = isPlainObject(tc.input) ? tc.input : {};
        if (tr) {
          parts.push({
            type: "dynamic-tool" as const,
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            state: "output-available" as const,
            input: safeInput,
            output: tr.output,
          });
        } else {
          parts.push({
            type: "dynamic-tool" as const,
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            state: "output-error" as const,
            input: safeInput,
            errorText: "Tool execution did not return a result",
          });
        }
      }
    }

    let text: string;
    if (!result.text) {
      text = fallbackText ?? "";
    } else {
      // Clean think/tool_call leaks before prefixing (handles both display and history pollution)
      let cleaned = cleanModelOutput(result.text);
      // Strip wrong-persona prefix: reactive persona may echo the active persona's [NAME] tag
      // because the conversation history is saturated with the other persona's prefix style.
      // Replace any [NAME] prefix that doesn't match the expected persona.
      cleaned = cleaned.replace(/^\[([^\]]+)\]\s*/, (match, name) => {
        return name === personaName ? match : "";
      });
      if (cleaned.startsWith(`[${personaName}]`)) {
        text = cleaned;
      } else {
        text = cleaned ? `[${personaName}] ${cleaned}` : "";
      }
    }
    if (text) {
      parts.push({ type: "text" as const, text: moderateOutput(this.name, text) });
    }

    if (parts.length === 0) return null;

    return {
      id: crypto.randomUUID(),
      role: "assistant",
      parts,
    };
  }

  /** Summarize the last tool calls made by the active persona for reactive context injection.
   *  Returns a 1-line summary string; empty string if no tool parts found. */
  private _describeLastAction(): string {
    const lastAssistantMsg = [...this.messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistantMsg) return "";

    const summaries: string[] = [];
    const getStr = (v: unknown): string => (typeof v === "string" && v.length > 0 ? v : "");
    for (const part of lastAssistantMsg.parts) {
      const p = part as Record<string, unknown>;
      const input = isPlainObject(p.input) ? (p.input as Record<string, unknown>) : {};
      // Prefer text/title/prompt for label - skip fill (it's a hex color, not a description)
      const detail = getStr(input.text) || getStr(input.title) || getStr(input.prompt);
      // tool-* parts: produced by streamText (primary/chat path)
      if (typeof p.type === "string" && p.type.startsWith("tool-") && p.type !== "dynamic-tool") {
        summaries.push((p.type as string).replace("tool-", "") + (detail ? `: "${detail}"` : ""));
        // dynamic-tool parts: produced by generateText (_buildGenerateTextMessage / director nudge path)
      } else if (p.type === "dynamic-tool" && typeof p.toolName === "string") {
        summaries.push(p.toolName + (detail ? `: "${detail}"` : ""));
      }
    }
    return summaries.slice(0, 3).join(", ");
  }

  /** After the active persona finishes, trigger the other persona to react.
   *  KEY-DECISION 2026-02-19: Claims _isGenerating mutex BEFORE the 2s UX delay to prevent
   *  TOCTOU races (human message arriving between check and claim would cause concurrent generation).
   *  KEY-DECISION 2026-02-21: maxCreates param lets crisis turns cap reactive at 1 (not 2) so
   *  the total per-turn canvas creation stays within the crisis budget (main=2 + reactive=1 = 3). */
  private async _triggerReactivePersona(activeIndex: number, personas?: Persona[], maxCreates = 2) {
    // Guard: scene budget exhausted - no reactive exchanges after scene ends
    const reactiveHumanTurns = this.messages.filter((m) => m.role === "user").length;
    if (computeBudgetPhase(reactiveHumanTurns, SCENE_TURN_BUDGET) === "scene-over") {
      console.debug(
        JSON.stringify({
          event: "reactive:skip",
          reason: "scene-over",
          boardId: this.name,
        }),
      );
      return;
    }

    // Guard: cooldown exceeded (check before claiming mutex)
    if (this._autonomousExchangeCount >= MAX_AUTONOMOUS_EXCHANGES) {
      console.debug(
        JSON.stringify({
          event: "reactive:skip",
          reason: "cooldown",
          boardId: this.name,
        }),
      );
      return;
    }

    // Guard: already generating (human message or concurrent caller)
    if (this._isGenerating) {
      console.debug(
        JSON.stringify({
          event: "reactive:skip",
          reason: "busy",
          boardId: this.name,
        }),
      );
      return;
    }

    // Claim mutex BEFORE the delay to prevent TOCTOU races
    this._autonomousExchangeCount++;
    await this.withGenerating(async () => {
      // UX delay - let the active persona's message settle before the reaction.
      // KEY-DECISION 2026-02-22: "no-assistant-message" guard moved to here (after delay) from
      // before withGenerating. Guard previously fired synchronously before onFinish() added the
      // assistant message to this.messages, causing SAGE to always skip turn 1. After 2s the
      // base class has long since persisted the message.
      await new Promise((r) => setTimeout(r, 2000));

      // Guard: need at least one assistant message to react to (checked after delay so onFinish
      // has had time to persist the active persona's response)
      if (!this.messages.some((m) => m.role === "assistant")) {
        console.debug(
          JSON.stringify({
            event: "reactive:skip",
            reason: "no-assistant-message",
            boardId: this.name,
          }),
        );
        return;
      }

      // Re-check: human may have interrupted during the delay (onChatMessage resets count)
      if (this._autonomousExchangeCount === 0) {
        console.debug(
          JSON.stringify({
            event: "reactive:skip",
            reason: "human-interrupted",
            boardId: this.name,
          }),
        );
        return;
      }

      // Load personas if not passed in (director nudge path).
      // withGenerating's finally handles _isGenerating = false if this throws.
      let effectivePersonas: Persona[];
      try {
        effectivePersonas = personas ?? (await this._getEffectivePersonas());
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "reactive:personas-error",
            boardId: this.name,
            error: String(err),
          }),
        );
        return;
      }
      // Skip reactive if only 1 persona (can't react to yourself)
      if (effectivePersonas.length <= 1) {
        console.debug(
          JSON.stringify({
            event: "reactive:skip",
            reason: "single-persona",
            boardId: this.name,
          }),
        );
        return;
      }
      const boundActive = activeIndex % effectivePersonas.length;
      const reactiveIndex = (boundActive + 1) % effectivePersonas.length;
      const reactivePersona = effectivePersonas[reactiveIndex];
      const activePersona = effectivePersonas[boundActive];
      const startTime = Date.now();
      this._logRequestStart("reactive", reactivePersona.name);

      const doId = this.env.BOARD.idFromName(this.name);
      const boardStub = this.env.BOARD.get(doId);
      const batchId = crypto.randomUUID();
      const tools = createSDKTools(boardStub, batchId, this.env.AI, this.ctx.storage, maxCreates);

      // Pass the same game mode block to the reactive persona
      const reactiveGameModeState: GameModeState = {
        yesAndCount: this._yesAndCount,
        haroldTurns: this.messages.filter((m) => m.role === "user").length,
      };
      const reactiveGameModeBlock = buildGameModePromptBlock(this._gameMode, reactiveGameModeState);

      // Extract what the active persona just created for context injection
      const lastActionSummary = this._describeLastAction();

      // Load scene relationships for reactive persona context
      const reactiveRelationships =
        (await this.ctx.storage.get<CharacterRelationship[]>("narrative:relationships")) ?? [];
      const reactiveRelBlock = buildRelationshipBlock(reactiveRelationships);

      // Load lifecycle phase for reactive persona (same storage key)
      const reactiveStoredPhase = await this.ctx.storage.get<SceneLifecyclePhase>("scene:lifecyclePhase");
      const reactiveLifecyclePhase = computeLifecyclePhase(
        this.messages.filter((m) => m.role === "user").length,
        reactiveStoredPhase ?? undefined,
      );

      const reactiveLifecycleBlock = `\n\n${buildLifecycleBlock(reactiveLifecyclePhase)}`;
      const reactiveSystem =
        buildPersonaSystemPrompt(
          reactivePersona,
          activePersona,
          SYSTEM_PROMPT,
          reactiveGameModeBlock,
          reactiveRelBlock,
        ) +
        reactiveLifecycleBlock +
        `\n\n[REACTIVE MODE] ${activePersona.name} just placed: ${lastActionSummary || "objects on the canvas"}. ` +
        `React in character with exactly 1 spoken sentence (required). ` +
        `A visual tool call is OPTIONAL - speaking alone is sufficient. If you do place an object, do NOT use batchExecute.`;

      const reactiveScenePhase = computeScenePhase(this.messages.filter((m) => m.role === "user").length);
      const model = this._getTracedModel("reactive", reactivePersona.name, {
        gameMode: this._gameMode,
        scenePhase: reactiveScenePhase,
      });

      // Show AI presence while generating
      await boardStub.setAiPresence(true).catch((err: unknown) => {
        console.debug(
          JSON.stringify({
            event: "ai:presence:start-error",
            trigger: "reactive",
            error: String(err),
          }),
        );
      });

      try {
        const { messages: sanitizedMsgs, repairedCount } = sanitizeMessages(this.messages);
        if (repairedCount > 0) this._traceSanitizeRepair("reactive", repairedCount);
        const result = await generateText({
          model,
          system: reactiveSystem,
          messages: await convertToModelMessages(sanitizedMsgs),
          tools,
          stopWhen: stepCountIs(2),
        });

        // Build and persist UIMessage from generateText result
        // KEY-DECISION 2026-02-20: No fallback text for reactive persona. If the model
        // returns only tool calls (placed an object without speaking), that's valid behavior.
        // Passing "[PERSONA] ..." as fallback caused persistent stuck "..." messages in chat
        // because generateText is not streaming - the fallback becomes the final text.
        const reactiveMessage = this._buildGenerateTextMessage(result, reactivePersona.name);
        if (reactiveMessage) {
          this.messages.push(reactiveMessage);
          await this.persistMessages(this.messages);
        }

        const totalToolCalls = result.steps.reduce((sum, s) => sum + s.toolCalls.length, 0);
        this._logRequestEnd("reactive", reactivePersona.name, startTime, result.steps.length, totalToolCalls);
        // StepResult<T> toolCalls are narrowly typed; _traceToolFailures accepts the common shape
        this._traceToolFailures("reactive", result.steps as any[]);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "reactive:error",
            boardId: this.name,
            persona: reactivePersona.name,
            autonomousExchangeCount: this._autonomousExchangeCount,
            error: String(err),
            // Include stack trace to distinguish programming bugs from transient AI/network errors
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
      } finally {
        // Toggle persona regardless of success/failure - prevents getting stuck
        this._activePersonaIndex = reactiveIndex;
        await boardStub.setAiPresence(false).catch((err: unknown) => {
          console.debug(
            JSON.stringify({
              event: "ai:presence:cleanup-error",
              trigger: "reactive",
              error: String(err),
            }),
          );
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // AI Director - proactive scene complications after inactivity
  // ---------------------------------------------------------------------------

  /** Cancel existing director schedule and set a new 60s timer */
  private _resetDirectorTimer() {
    this.ctx.waitUntil(
      (async () => {
        try {
          // Cancel any existing director nudge schedules
          const existing = this.getSchedules({ type: "delayed" });
          for (const s of existing) {
            if (s.callback === "onDirectorNudge") {
              await this.cancelSchedule(s.id);
            }
          }
          // Only schedule if there's an active scene (messages exist)
          if (this.messages.length > 0) {
            await this.schedule(60, "onDirectorNudge" as keyof this);
            console.debug(
              JSON.stringify({
                event: "director:timer-set",
                boardId: this.name,
                delaySeconds: 60,
              }),
            );
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "director:timer-error",
              boardId: this.name,
              error: String(err),
            }),
          );
        }
      })(),
    );
  }

  // ---------------------------------------------------------------------------
  // Auto-director - canvas action RPC stub (T2 implements reaction engine)
  // ---------------------------------------------------------------------------

  /** Receives canvas mutation notifications from Board DO after each player action.
   *  Buffers significant actions and resets the 5s debounce timer.
   *  Non-significant actions (position drags) reset the timer without buffering,
   *  preventing reactions from firing mid-drag. */
  async onCanvasAction(action: CanvasAction): Promise<void> {
    console.debug(
      JSON.stringify({
        event: "canvas-action:received",
        boardId: this.name,
        type: action.type,
        userId: action.userId,
        username: action.username,
        objectId: action.objectId,
        objectType: action.objectType,
        significant: action.significant,
        ts: action.ts,
      }),
    );

    // Buffer significant actions for interest scoring (position drags are not significant)
    if (action.significant) {
      this._pendingCanvasActions.push(action);
    }

    // Reset the 5s canvas-reaction timer on ALL actions (including non-significant drags).
    // KEY-DECISION 2026-02-20: Cancel-then-reschedule on every action so drag repositioning
    // suppresses the reaction timer. Players dragging should not trigger canvas reactions.
    // Timer is only rescheduled if there are buffered significant actions to react to.
    try {
      const existing = this.getSchedules({ type: "delayed" });
      for (const s of existing) {
        if (s.callback === "onCanvasReaction") {
          await this.cancelSchedule(s.id);
        }
      }
      if (this.messages.length > 0 && this._pendingCanvasActions.length > 0) {
        await this.schedule(5, "onCanvasReaction" as keyof this);
        console.debug(
          JSON.stringify({
            event: "canvas-action:timer-set",
            boardId: this.name,
            pendingCount: this._pendingCanvasActions.length,
            delaySeconds: 5,
          }),
        );
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "canvas-action:timer-error",
          boardId: this.name,
          error: String(err),
        }),
      );
    }
  }

  /** Receives audience heckle notifications from Board DO.
   *  Buffers text for injection into the AI's next chat response system prompt.
   *  KEY-DECISION 2026-02-20: Buffer-and-inject (not immediate reaction) so heckles surface
   *  naturally in the next player exchange rather than interrupting mid-improv. */
  async onHeckle(userId: string, text: string): Promise<void> {
    console.debug(JSON.stringify({ event: "heckle:received", boardId: this.name, userId, textLen: text.length }));
    this._pendingHeckles.push(text);
  }

  /** Receives poll result from Board DO when 15s voting window closes.
   *  Stores result for injection into next AI response (same buffer pattern as heckles).
   *  KEY-DECISION 2026-02-21: Single result stored (not an array) - only one poll can be
   *  active at a time, so at most one result arrives before the next human exchange. */
  async onPollResult(result: import("../shared/types").PollResult): Promise<void> {
    console.debug(
      JSON.stringify({
        event: "poll-result:received",
        boardId: this.name,
        pollId: result.pollId,
        winner: result.winner.label,
        totalVotes: result.totalVotes,
      }),
    );
    this._pendingPollResult = result;
  }

  /** Receives audience wave notification from Board DO (3+ spectators same emoji within 5s).
   *  Buffers atmospheric prompt for injection into next AI response.
   *  KEY-DECISION 2026-02-21: Same buffer-and-inject pattern as heckles - wave context flows
   *  naturally into the improv rather than interrupting. Only most recent wave is used if multiple
   *  fire before the next AI response. */
  async onAudienceWave(emoji: string, count: number): Promise<void> {
    console.debug(JSON.stringify({ event: "audience-wave:received", boardId: this.name, emoji, count }));
    this._pendingWavePrompts.push(buildWavePrompt(emoji, count));
  }

  /** Receives SFX trigger from Board DO. Buffers label and schedules a fast 2s reaction.
   *  KEY-DECISION 2026-02-20: SFX uses a dedicated onSfxReaction schedule (not onCanvasReaction)
   *  to avoid interfering with the 5s canvas-action debounce and to bypass the interest-score
   *  guard - a player-triggered sound cue is inherently interesting. */
  async onSfxAction(effectId: string, label: string): Promise<void> {
    console.debug(JSON.stringify({ event: "sfx:received", boardId: this.name, effectId, label }));
    if (this.messages.length === 0) return; // no scene started yet
    this._pendingSfxLabels.push(label);
    // Cancel any existing sfx reaction schedule and set a fresh 2s one
    try {
      const existing = this.getSchedules({ type: "delayed" });
      for (const s of existing) {
        if (s.callback === "onSfxReaction") await this.cancelSchedule(s.id);
      }
      await this.schedule(2, "onSfxReaction" as keyof this);
    } catch (err) {
      console.warn(JSON.stringify({ event: "sfx:timer-error", boardId: this.name, error: String(err) }));
    }
  }

  /** Called by DO schedule 2s after SFX trigger - generates an in-character reaction. */
  async onSfxReaction(): Promise<void> {
    const labels = this._pendingSfxLabels;
    this._pendingSfxLabels = [];

    if (labels.length === 0) return;
    if (this._isGenerating) {
      console.debug(JSON.stringify({ event: "sfx-reaction:skip", reason: "generating", boardId: this.name }));
      return;
    }
    if (this.messages.length === 0) return;
    const humanTurns = this.messages.filter((m) => m.role === "user").length;
    if (computeBudgetPhase(humanTurns, SCENE_TURN_BUDGET) === "scene-over") {
      console.debug(JSON.stringify({ event: "sfx-reaction:skip", reason: "scene-over", boardId: this.name }));
      return;
    }

    await this.withGenerating(async () => {
      const startTime = Date.now();
      const personas = await this._getEffectivePersonas();
      const reactionIndex = this._activePersonaIndex % personas.length;
      const reactionPersona = personas[reactionIndex];
      const reactionOther = personas.length > 1 ? personas[(reactionIndex + 1) % personas.length] : undefined;

      this._logRequestStart("sfx-reaction", reactionPersona.name, { labels });

      const doId = this.env.BOARD.idFromName(this.name);
      const boardStub = this.env.BOARD.get(doId);
      const batchId = crypto.randomUUID();
      const tools = createSDKTools(boardStub, batchId, this.env.AI, this.ctx.storage, 1);

      await boardStub.setAiPresence(true).catch((err: unknown) => {
        console.debug(
          JSON.stringify({ event: "ai:presence:start-error", trigger: "sfx-reaction", error: String(err) }),
        );
      });

      try {
        const relationships = (await this.ctx.storage.get<CharacterRelationship[]>("narrative:relationships")) ?? [];
        const relBlock = buildRelationshipBlock(relationships);
        const gameModeState: GameModeState = {
          yesAndCount: this._yesAndCount,
          haroldTurns: humanTurns,
        };
        const gameModeBlock = buildGameModePromptBlock(this._gameMode, gameModeState);
        const storedPhase = await this.ctx.storage.get<SceneLifecyclePhase>("scene:lifecyclePhase");
        const lifecyclePhase = computeLifecyclePhase(humanTurns, storedPhase ?? undefined);
        const lifecycleBlock = `\n\n${buildLifecycleBlock(lifecyclePhase)}`;

        const sfxSystem =
          buildPersonaSystemPrompt(reactionPersona, reactionOther, SYSTEM_PROMPT, gameModeBlock, relBlock) +
          lifecycleBlock +
          `\n\n${buildSfxReactionPrompt(labels)}`;

        const { messages: sanitizedMsgs, repairedCount } = sanitizeMessages(this.messages);
        if (repairedCount > 0) this._traceSanitizeRepair("sfx-reaction", repairedCount);

        const result = await generateText({
          model: this._getTracedModel("sfx-reaction", reactionPersona.name, { gameMode: this._gameMode }),
          system: sfxSystem,
          messages: await convertToModelMessages(sanitizedMsgs),
          tools,
          stopWhen: stepCountIs(2),
        });

        const reactionMessage = this._buildGenerateTextMessage(result, reactionPersona.name);
        if (reactionMessage) {
          this.messages.push(reactionMessage);
          await this.persistMessages(this.messages);
        }

        const totalToolCalls = result.steps.reduce((sum, s) => sum + s.toolCalls.length, 0);
        this._logRequestEnd("sfx-reaction", reactionPersona.name, startTime, result.steps.length, totalToolCalls, {
          labels,
        });
        // StepResult<T> toolCalls are narrowly typed; _traceToolFailures accepts the common shape
        this._traceToolFailures("sfx-reaction", result.steps as any[]);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "sfx-reaction:error",
            boardId: this.name,
            persona: reactionPersona.name,
            error: String(err),
          }),
        );
      } finally {
        await boardStub.setAiPresence(false).catch((err: unknown) => {
          console.debug(
            JSON.stringify({ event: "ai:presence:cleanup-error", trigger: "sfx-reaction", error: String(err) }),
          );
        });
      }
    });
  }

  /** Called by DO schedule after 5s of player idle - reacts to recent canvas mutations in character.
   *  Drains the pending action buffer, scores interest level, and generates a reaction if the
   *  scene warrants it. Guards prevent reactions during active generation or chat. */
  async onCanvasReaction(_payload: unknown, currentSchedule?: { id: string }) {
    // Guard: skip if a newer canvas-reaction schedule exists (this one is stale).
    // KEY-DECISION 2026-02-20: Check newer-timer BEFORE draining buffer - if a newer schedule
    // exists, we preserve the buffer for it (draining would leave the newer schedule empty).
    const allSchedules = this.getSchedules({ type: "delayed" });
    const hasPending = allSchedules.some((s) => s.callback === "onCanvasReaction" && s.id !== currentSchedule?.id);
    if (hasPending) {
      console.debug(JSON.stringify({ event: "canvas-reaction:skip", reason: "newer-timer", boardId: this.name }));
      return;
    }

    // Drain buffer (always, once we've confirmed we're the active timer)
    const actions = this._pendingCanvasActions;
    this._pendingCanvasActions = [];

    // Guard 1: empty buffer
    if (actions.length === 0) {
      console.debug(JSON.stringify({ event: "canvas-reaction:skip", reason: "empty-buffer", boardId: this.name }));
      return;
    }

    // Guard 2: another AI generation in progress
    if (this._isGenerating) {
      console.debug(JSON.stringify({ event: "canvas-reaction:skip", reason: "generating", boardId: this.name }));
      return;
    }

    // Guard 3: cooldown active (30s between canvas reactions)
    const now = Date.now();
    if (now < this._canvasReactionCooldownUntil) {
      console.debug(
        JSON.stringify({
          event: "canvas-reaction:skip",
          reason: "cooldown",
          boardId: this.name,
          cooldownRemainingMs: this._canvasReactionCooldownUntil - now,
        }),
      );
      return;
    }

    // Guard 4: no scene started yet
    if (this.messages.length === 0) {
      console.debug(JSON.stringify({ event: "canvas-reaction:skip", reason: "no-messages", boardId: this.name }));
      return;
    }

    // Guard 5: scene budget exhausted
    const humanTurns = this.messages.filter((m) => m.role === "user").length;
    if (computeBudgetPhase(humanTurns, SCENE_TURN_BUDGET) === "scene-over") {
      console.debug(JSON.stringify({ event: "canvas-reaction:skip", reason: "scene-over", boardId: this.name }));
      return;
    }

    // Guard 6: player sent a chat message in the last 10s (they're engaged in chat, not just placing objects)
    if (now - this._lastHumanMessageAt < 10_000) {
      console.debug(
        JSON.stringify({
          event: "canvas-reaction:skip",
          reason: "recent-chat",
          boardId: this.name,
          msSinceChat: now - this._lastHumanMessageAt,
        }),
      );
      return;
    }

    // Interest scoring - only react if the buffered actions are sufficiently interesting
    let score = 0;
    for (const a of actions) {
      if (a.type === "obj:create") {
        score += a.objectType === "person" || a.objectType === "frame" || a.objectType === "sticky" ? 2 : 1;
      } else if (a.type === "obj:delete") {
        score += 1;
      } else if (a.type === "obj:update" && a.text) {
        score += 1;
      }
    }

    console.debug(
      JSON.stringify({
        event: "canvas-reaction:evaluate",
        boardId: this.name,
        score,
        actionCount: actions.length,
        threshold: 2,
      }),
    );

    if (score < 2) {
      console.debug(
        JSON.stringify({ event: "canvas-reaction:skip", reason: "low-interest", boardId: this.name, score }),
      );
      return;
    }

    // React! - pre-declare so they are accessible after withGenerating releases the mutex
    let didReact = false;
    let savedReactionIndex = 0;
    let savedReactionPersonas: Persona[] = [];

    await this.withGenerating(async () => {
      const startTime = Date.now();
      const reactionPersonas = await this._getEffectivePersonas();
      const reactionIndex = this._activePersonaIndex % reactionPersonas.length;
      const reactionPersona = reactionPersonas[reactionIndex];
      const reactionOther =
        reactionPersonas.length > 1 ? reactionPersonas[(reactionIndex + 1) % reactionPersonas.length] : undefined;

      savedReactionIndex = reactionIndex;
      savedReactionPersonas = reactionPersonas;

      this._logRequestStart("canvas-action", reactionPersona.name, { actionCount: actions.length, score });

      const doId = this.env.BOARD.idFromName(this.name);
      const boardStub = this.env.BOARD.get(doId);
      const batchId = crypto.randomUUID();
      const tools = createSDKTools(boardStub, batchId, this.env.AI, this.ctx.storage, 1);

      await boardStub.setAiPresence(true).catch((err: unknown) => {
        console.debug(
          JSON.stringify({ event: "ai:presence:start-error", trigger: "canvas-action", error: String(err) }),
        );
      });

      try {
        const relationships = (await this.ctx.storage.get<CharacterRelationship[]>("narrative:relationships")) ?? [];
        const relBlock = buildRelationshipBlock(relationships);

        const gameModeState: GameModeState = {
          yesAndCount: this._yesAndCount,
          haroldTurns: humanTurns,
        };
        const gameModeBlock = buildGameModePromptBlock(this._gameMode, gameModeState);

        const storedPhase = await this.ctx.storage.get<SceneLifecyclePhase>("scene:lifecyclePhase");
        const lifecyclePhase = computeLifecyclePhase(humanTurns, storedPhase ?? undefined);
        const lifecycleBlock = `\n\n${buildLifecycleBlock(lifecyclePhase)}`;

        const canvasReactionSystem =
          buildPersonaSystemPrompt(reactionPersona, reactionOther, SYSTEM_PROMPT, gameModeBlock, relBlock) +
          lifecycleBlock +
          `\n\n${buildCanvasReactionPrompt(actions)}`;

        const { messages: sanitizedMsgs, repairedCount } = sanitizeMessages(this.messages);
        if (repairedCount > 0) this._traceSanitizeRepair("canvas-action", repairedCount);

        const result = await generateText({
          model: this._getTracedModel("canvas-action", reactionPersona.name, { gameMode: this._gameMode }),
          system: canvasReactionSystem,
          messages: await convertToModelMessages(sanitizedMsgs),
          tools,
          stopWhen: stepCountIs(2),
        });

        // No fallback text - same fix as reactive persona (see KEY-DECISION above)
        const reactionMessage = this._buildGenerateTextMessage(result, reactionPersona.name);
        if (reactionMessage) {
          this.messages.push(reactionMessage);
          await this.persistMessages(this.messages);
        }

        const totalToolCalls = result.steps.reduce((sum, s) => sum + s.toolCalls.length, 0);
        this._logRequestEnd("canvas-action", reactionPersona.name, startTime, result.steps.length, totalToolCalls, {
          score,
          actionCount: actions.length,
        });
        // StepResult<T> toolCalls are narrowly typed; _traceToolFailures accepts the common shape
        this._traceToolFailures("canvas-action", result.steps as any[]);

        // Set 30s cooldown to prevent back-to-back canvas reactions
        this._canvasReactionCooldownUntil = Date.now() + 30_000;
        didReact = true;
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "canvas-reaction:error",
            boardId: this.name,
            persona: reactionPersona.name,
            score,
            error: String(err),
          }),
        );
      } finally {
        await boardStub.setAiPresence(false).catch((err: unknown) => {
          console.debug(
            JSON.stringify({ event: "ai:presence:cleanup-error", trigger: "canvas-action", error: String(err) }),
          );
        });
      }
    });

    // Trigger reactive persona AFTER withGenerating releases _isGenerating = false,
    // so _triggerReactivePersona's busy guard passes.
    if (didReact) {
      // Reset director timer (AI just acted - restart 60s inactivity window)
      this._resetDirectorTimer();
      this._autonomousExchangeCount++;
      this.ctx.waitUntil(
        this._triggerReactivePersona(savedReactionIndex, savedReactionPersonas).catch((err: unknown) => {
          console.error(JSON.stringify({ event: "reactive:unhandled", boardId: this.name, error: String(err) }));
        }),
      );
    }
  }

  /** Called by DO alarm after 60s of inactivity - generates a proactive scene complication */
  async onDirectorNudge(_payload: unknown, currentSchedule?: { id: string }) {
    // Guard: skip if another timer was set after this one fired
    // Note: the SDK deletes the schedule row AFTER the callback returns,
    // so we must exclude the currently-executing schedule by ID
    const lastSchedules = this.getSchedules({ type: "delayed" });
    const hasPending = lastSchedules.some((s) => s.callback === "onDirectorNudge" && s.id !== currentSchedule?.id);
    if (hasPending) {
      console.debug(
        JSON.stringify({
          event: "director:skip",
          reason: "newer-timer",
          boardId: this.name,
        }),
      );
      return;
    }

    // Guard: skip if AI is already generating a response
    if (this._isGenerating) {
      console.debug(
        JSON.stringify({
          event: "director:skip",
          reason: "generating",
          boardId: this.name,
        }),
      );
      return;
    }

    // Guard: skip if no scene started
    if (this.messages.length === 0) {
      console.debug(
        JSON.stringify({
          event: "director:skip",
          reason: "no-messages",
          boardId: this.name,
        }),
      );
      return;
    }

    // Guard: skip if scene budget exhausted - don't nudge a completed scene
    const directorHumanTurns = this.messages.filter((m) => m.role === "user").length;
    const directorBudget = computeBudgetPhase(directorHumanTurns, SCENE_TURN_BUDGET);
    if (directorBudget === "scene-over") {
      console.debug(
        JSON.stringify({
          event: "director:skip",
          reason: "scene-over",
          boardId: this.name,
          humanTurns: directorHumanTurns,
        }),
      );
      return;
    }

    // Pre-declare so they are accessible after withGenerating releases the mutex
    let directorTriggered = false;
    let savedDirectorIndex = 0;
    let savedDirectorPersonas: Persona[] = [];

    await this.withGenerating(async () => {
      const startTime = Date.now();
      const directorPersonas = await this._getEffectivePersonas();
      const directorIndex = this._activePersonaIndex % directorPersonas.length;
      const directorPersona = directorPersonas[directorIndex];
      const directorOther =
        directorPersonas.length > 1 ? directorPersonas[(directorIndex + 1) % directorPersonas.length] : undefined;

      savedDirectorIndex = directorIndex;
      savedDirectorPersonas = directorPersonas;

      // Determine scene phase from user message count
      const userMessageCount = directorHumanTurns;
      const phase = computeScenePhase(userMessageCount);
      this._logRequestStart("director", directorPersona.name, {
        messageCount: this.messages.length,
        budgetPhase: directorBudget,
      });

      const doId = this.env.BOARD.idFromName(this.name);
      const boardStub = this.env.BOARD.get(doId);
      const batchId = crypto.randomUUID();
      const tools = createSDKTools(boardStub, batchId, this.env.AI, this.ctx.storage, 2);

      // Show AI presence while generating
      await boardStub.setAiPresence(true).catch((err: unknown) => {
        console.debug(
          JSON.stringify({
            event: "ai:presence:start-error",
            trigger: "director",
            error: String(err),
          }),
        );
      });

      try {
        // Build game mode block for director
        const directorGameModeState: GameModeState = {
          yesAndCount: this._yesAndCount,
          haroldTurns: directorHumanTurns,
        };
        const directorGameModeBlock = buildGameModePromptBlock(this._gameMode, directorGameModeState);

        // Mode-specific director instructions
        let directorInstructions: string;
        if (this._gameMode === "harold") {
          const haroldKey = directorHumanTurns >= 14 ? "wrapup" : "active";
          directorInstructions = DIRECTOR_PROMPTS_HAROLD[haroldKey];
        } else if (this._gameMode === "yesand") {
          const yesandKey = this._yesAndCount >= 10 ? "wrapup" : "active";
          directorInstructions = DIRECTOR_PROMPTS_YESAND[yesandKey];
        } else {
          directorInstructions = `Current scene phase: ${phase.toUpperCase()}. ` + DIRECTOR_PROMPTS[phase];
        }

        // Load scene relationships for director context
        const directorRelationships =
          (await this.ctx.storage.get<CharacterRelationship[]>("narrative:relationships")) ?? [];
        const directorRelBlock = buildRelationshipBlock(directorRelationships);

        // Load lifecycle phase for director (auto-computed from user message count)
        const directorStoredPhase = await this.ctx.storage.get<SceneLifecyclePhase>("scene:lifecyclePhase");
        const directorLifecyclePhase = computeLifecyclePhase(directorHumanTurns, directorStoredPhase ?? undefined);
        const directorLifecycleBlock = `\n\n${buildLifecycleBlock(directorLifecyclePhase)}`;

        // Director nudge uses the active persona's voice + budget-aware prompts
        let directorSystem =
          buildPersonaSystemPrompt(
            directorPersona,
            directorOther,
            SYSTEM_PROMPT,
            directorGameModeBlock,
            directorRelBlock,
          ) +
          directorLifecycleBlock +
          `\n\n[DIRECTOR MODE] You are the scene director. The players have been quiet for a while. ` +
          directorInstructions +
          `\n\nAct NOW - add something to the canvas to restart momentum. ` +
          `Keep your chat response to 1 sentence max, something provocative that invites players to react.`;
        if (directorBudget !== "normal") {
          directorSystem += `\n\n${BUDGET_PROMPTS[directorBudget]}`;
        }

        const { messages: sanitizedMsgs, repairedCount } = sanitizeMessages(this.messages);
        if (repairedCount > 0) this._traceSanitizeRepair("director", repairedCount);
        const result = await generateText({
          model: this._getTracedModel("director", directorPersona.name, {
            gameMode: this._gameMode,
            scenePhase: phase,
          }),
          system: directorSystem,
          messages: await convertToModelMessages(sanitizedMsgs),
          tools,
          stopWhen: stepCountIs(3),
        });

        // Build and persist UIMessage from generateText result
        const directorMessage = this._buildGenerateTextMessage(result, directorPersona.name);
        if (directorMessage) {
          this.messages.push(directorMessage);
          await this.persistMessages(this.messages);
        }

        const totalToolCalls = result.steps.reduce((sum, s) => sum + s.toolCalls.length, 0);
        this._logRequestEnd("director", directorPersona.name, startTime, result.steps.length, totalToolCalls, {
          phase,
        });
        // StepResult<T> toolCalls are narrowly typed; _traceToolFailures accepts the common shape
        this._traceToolFailures("director", result.steps as any[]);

        directorTriggered = true;
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "director:nudge-error",
            boardId: this.name,
            persona: directorPersona.name,
            phase,
            error: String(err),
          }),
        );
      } finally {
        await boardStub.setAiPresence(false).catch((err: unknown) => {
          console.debug(
            JSON.stringify({
              event: "ai:presence:cleanup-error",
              trigger: "director",
              error: String(err),
            }),
          );
        });
      }
    });

    // Trigger reactive persona AFTER withGenerating releases _isGenerating = false,
    // so _triggerReactivePersona's busy guard passes.
    // Pass directorPersonas to avoid a redundant second D1 query.
    if (directorTriggered) {
      this._autonomousExchangeCount++;
      this.ctx.waitUntil(
        this._triggerReactivePersona(savedDirectorIndex, savedDirectorPersonas).catch((err: unknown) => {
          console.error(
            JSON.stringify({
              event: "reactive:unhandled",
              boardId: this.name,
              error: String(err),
            }),
          );
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // "Previously On..." Recap - RPC method called by /api/boards/:id/recap
  // ---------------------------------------------------------------------------

  /**
   * Generate a dramatic TV-style "Previously on..." recap narration for the board.
   * RPC-callable from index.ts after the caller verifies sufficient replay events.
   *
   * Returns { available: false } when:
   *   - fewer than 3 human messages in history (not enough story to recap)
   *   - AI generation fails (fail-open: user sees no recap, not an error)
   *
   * KEY-DECISION 2026-02-20: Cached by message count (recap:msgcount storage key).
   * Any new message invalidates the cache, ensuring fresh recaps after each session.
   * Using Claude Haiku directly (not this._getModel()) for theatrical prose quality -
   * Workers AI models produce stilted output for narrative one-shots.
   */
  async generateRecap(): Promise<{ available: boolean; narration?: string }> {
    const humanMessages = this.messages.filter((m) => m.role === "user");
    if (humanMessages.length < 3) {
      return { available: false };
    }

    // Cache invalidation: if message count matches, return cached narration
    const [cachedNarration, cachedMsgCount] = await Promise.all([
      this.ctx.storage.get<string>("recap:latest"),
      this.ctx.storage.get<number>("recap:msgcount"),
    ]);
    if (cachedNarration && cachedMsgCount === this.messages.length) {
      return { available: true, narration: cachedNarration };
    }

    // Build transcript from last 15 messages (text parts only, strips tool calls)
    const recentMessages = this.messages.slice(-15);
    const chatLines: string[] = [];
    for (const msg of recentMessages) {
      if (!msg.parts) continue;
      const textParts = msg.parts
        .filter((p) => (p as { type: string }).type === "text")
        .map((p) => (p as { type: string; text: string }).text)
        .filter((t) => t && t.trim().length > 5);
      if (textParts.length === 0) continue;
      const label = msg.role === "user" ? "Player" : "AI";
      chatLines.push(`${label}: ${textParts.join(" ").slice(0, 200)}`);
    }
    const transcript = chatLines.join("\n");
    if (!transcript) return { available: false };

    // Prefer Anthropic for theatrical prose; fall back to board's configured model
    const model = this.env.ANTHROPIC_API_KEY
      ? createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-haiku-4-5-20251001")
      : this._getModel();

    try {
      const result = await generateText({
        model,
        messages: [
          {
            role: "user",
            content: `Here is a transcript of an improv scene:\n\n${transcript}\n\nWrite a dramatic TV narrator-style "Previously on..." recap in 3-5 sentences. Be theatrical, highlight key moments and characters. End with a cliffhanger question or dramatic statement. Under 150 words. No meta-commentary, just narrate the scene.`,
          },
        ],
      });

      const narration = cleanModelOutput(result.text);
      if (!narration) return { available: false };

      // Cache keyed to current message count - auto-invalidates on new messages
      await Promise.all([
        this.ctx.storage.put("recap:latest", narration),
        this.ctx.storage.put("recap:msgcount", this.messages.length),
      ]);
      return { available: true, narration };
    } catch (err) {
      console.error(JSON.stringify({ event: "recap:error", boardId: this.name, error: String(err) }));
      return { available: false };
    }
  }
}
