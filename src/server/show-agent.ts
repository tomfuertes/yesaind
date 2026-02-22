/**
 * ShowAgent Durable Object - autonomous AI improv show runner.
 * Two AI personas (SPARK and SAGE) take turns creating objects on a shared canvas
 * while spectators watch via the existing SpectatorView infrastructure.
 *
 * KEY-DECISION 2026-02-22: DO alarms as the turn primitive. Survives hibernation unlike
 * while-true loops. Each alarm fires one persona turn, persists state, and schedules
 * the next alarm. The DO is headless - no WebSocket clients. Board DO handles all
 * spectator broadcasting (existing infra, zero changes needed).
 *
 * KEY-DECISION 2026-02-22: All state in ctx.storage, not class properties. DO hibernates
 * between alarm intervals - class properties reset on wake. Storage is the only reliable
 * state across hibernation boundaries.
 *
 * KEY-DECISION 2026-02-22: ShowAgent does NOT extend AIChatAgent. Shows are headless
 * (no client WebSockets). Plain DurableObject with ctx.storage is correct.
 */

import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createSDKTools } from "./ai-tools-sdk";
import type { CreateBudget, SharedBounds } from "./ai-tools-sdk";
import { buildPersonaSystemPrompt } from "./prompts/personas";
import { SYSTEM_PROMPT } from "./prompts/system";
import type { BoardStub } from "../shared/types";
import { DEFAULT_PERSONAS } from "../shared/types";
import type { Bindings } from "./env";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHOW_TURN_BUDGET = 12;
const SHOW_ALARM_INTERVAL_MS = 10000;

/** Delay before first alarm fires - gives spectators time to connect */
const SHOW_START_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Storage key shape (all state lives here - DO hibernates between alarms)
// ---------------------------------------------------------------------------

interface ShowState {
  turnCount: number;
  currentPersonaIndex: number; // 0=SPARK, 1=SAGE
  premise: string;
  status: "running" | "stopped" | "ended";
  boardId: string;
  isGenerating: boolean;
}

// ---------------------------------------------------------------------------
// Phase instruction helpers
// ---------------------------------------------------------------------------

function getPhaseInstruction(turnCount: number): string {
  if (turnCount <= 2) return "OPENING: Establish characters and their world";
  if (turnCount <= 5) return "FIRST BEATS: Introduce a complication";
  if (turnCount <= 8) return "SECOND BEATS: Escalate - things get worse";
  return "THIRD BEATS: Everything comes to a head and resolves";
}

function buildTurnUserMessage(turnCount: number, premise: string): string {
  const lines: string[] = [
    `[SHOW TURN ${turnCount + 1} of ${SHOW_TURN_BUDGET}]`,
    `You are performing in an AI improv show. The premise: "${premise}"`,
    "",
    getPhaseInstruction(turnCount),
    "",
    "Call getBoardState to see what has happened on stage so far, then yes-and the scene.",
  ];

  if (turnCount === 0) {
    lines.push("SCENE SETUP: Establish the world. Create 1 location frame with 2 characters inside it.");
  }

  if (turnCount >= 6 && turnCount <= 8) {
    lines.push("CRISIS MOMENT: Escalate the stakes. React to what is ON STAGE. Prefer effects over new objects.");
  }

  if (turnCount === SHOW_TURN_BUDGET - 1) {
    lines.push('FINAL BEAT: Resolve the scene. Use advanceScenePhase("curtain") and play_sfx("applause").');
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ShowAgent DO
// ---------------------------------------------------------------------------

export class ShowAgent extends DurableObject<Bindings> {
  /** Start a new show - store initial state and schedule the first alarm */
  async startShow(premise: string, boardId: string): Promise<void> {
    const state: ShowState = {
      turnCount: 0,
      currentPersonaIndex: 0,
      premise,
      status: "running",
      boardId,
      isGenerating: false,
    };

    await this.ctx.storage.put("show:state", state);

    // Small delay so spectators can connect before the first turn fires
    await this.ctx.storage.setAlarm(Date.now() + SHOW_START_DELAY_MS);

    console.log(
      JSON.stringify({
        event: "show:start",
        boardId,
        premise: premise.slice(0, 80),
      }),
    );
  }

  /** Request show stop - next alarm will see the status and call endShow() */
  async stopShow(): Promise<void> {
    const state = await this.ctx.storage.get<ShowState>("show:state");
    if (!state) return;
    await this.ctx.storage.put("show:state", { ...state, status: "stopped" });
    console.log(JSON.stringify({ event: "show:stop-requested", boardId: state.boardId }));
  }

  /** Return current show status for the API status endpoint */
  async getStatus(): Promise<{
    turnCount: number;
    status: ShowState["status"];
    premise: string;
    boardId: string;
  } | null> {
    const state = await this.ctx.storage.get<ShowState>("show:state");
    if (!state) return null;
    return {
      turnCount: state.turnCount,
      status: state.status,
      premise: state.premise,
      boardId: state.boardId,
    };
  }

  /** DO alarm handler - runs one persona turn */
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ShowState>("show:state");
    if (!state) {
      console.error(JSON.stringify({ event: "show:alarm:no-state" }));
      return;
    }

    const { turnCount, currentPersonaIndex, premise, status, boardId, isGenerating } = state;

    // Guard: overlapping alarms can happen if a prior turn ran long and the alarm
    // fired again. Reschedule 5s later and return.
    if (isGenerating) {
      console.log(JSON.stringify({ event: "show:alarm:guard-skip", boardId, turnCount }));
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }

    // Terminal conditions: stop requested or budget exhausted
    if (status !== "running" || turnCount >= SHOW_TURN_BUDGET) {
      await this._endShow(state);
      return;
    }

    // Claim the generating lock
    await this.ctx.storage.put("show:state", { ...state, isGenerating: true });

    try {
      await this._runTurn(boardId, premise, turnCount, currentPersonaIndex);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "show:alarm:error",
          boardId,
          turnCount,
          error: String(err),
        }),
      );
    } finally {
      // Always release lock and advance state, even on error (skip the failed turn)
      const nextTurnCount = turnCount + 1;
      const nextPersonaIndex = (currentPersonaIndex + 1) % 2;

      const updatedState: ShowState = {
        ...state,
        turnCount: nextTurnCount,
        currentPersonaIndex: nextPersonaIndex,
        isGenerating: false,
        // If we just completed the last turn, set ended; otherwise stay running
        status: nextTurnCount >= SHOW_TURN_BUDGET ? "ended" : state.status,
      };
      await this.ctx.storage.put("show:state", updatedState);

      if (updatedState.status === "ended") {
        await this._endShow(updatedState);
      } else {
        await this.ctx.storage.setAlarm(Date.now() + SHOW_ALARM_INTERVAL_MS);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Run one AI persona turn: build prompt, call generateText, tools mutate the board */
  private async _runTurn(boardId: string, premise: string, turnCount: number, personaIndex: number): Promise<void> {
    // Board DO is addressed by name (UUID boardId), same as ChatAgent and index.ts routes.
    const doId = this.env.BOARD.idFromName(boardId);
    const boardStub = this.env.BOARD.get(doId) as unknown as BoardStub;

    // Normal budget for shows (not crisis-capped - drama unfolds at the prompt level)
    const createBudget: CreateBudget = { used: 0 };
    const sharedBounds: SharedBounds = [];
    const batchId = crypto.randomUUID();
    const tools = createSDKTools(
      boardStub,
      batchId,
      undefined, // no AI image binding for shows
      this.ctx.storage,
      4, // maxCreates per closure (normal budget)
      createBudget,
      6, // globalMaxCreates
      sharedBounds,
      false, // qaMode
    );

    // Personas: 0=SPARK (even turns), 1=SAGE (odd turns)
    const personas = DEFAULT_PERSONAS;
    const activePersona = personas[personaIndex];
    const otherPersona = personas[(personaIndex + 1) % 2];

    // Build system prompt with persona identity and partner awareness
    // KEY-DECISION 2026-02-22: No game mode block for shows - the turn phase instructions
    // in the user message replace game mode coaching. buildPersonaSystemPrompt handles the
    // [CHARACTER IDENTITY] and [IMPROV PARTNER] sections.
    const systemPrompt = buildPersonaSystemPrompt(activePersona, otherPersona, SYSTEM_PROMPT);

    const userMessage = buildTurnUserMessage(turnCount, premise);

    console.log(
      JSON.stringify({
        event: "show:turn:start",
        boardId,
        turn: turnCount + 1,
        total: SHOW_TURN_BUDGET,
        persona: activePersona.name,
      }),
    );

    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    // KEY-DECISION 2026-02-22: generateText (not streamText) - no client to stream to.
    // Always Haiku for shows: cost-optimal ($0.007/turn), well-tuned for this prompt.
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools,
      stopWhen: stepCountIs(10), // allow multi-step tool use (getBoardState -> create objects)
    });

    console.log(
      JSON.stringify({
        event: "show:turn:done",
        boardId,
        turn: turnCount + 1,
        persona: activePersona.name,
        steps: result.steps?.length ?? 0,
        textLength: result.text?.length ?? 0,
      }),
    );
  }

  /** Mark show as ended and delete the alarm */
  private async _endShow(state: ShowState): Promise<void> {
    await this.ctx.storage.put("show:state", {
      ...state,
      status: "ended",
      isGenerating: false,
    });
    await this.ctx.storage.deleteAlarm();
    console.log(
      JSON.stringify({
        event: "show:ended",
        boardId: state.boardId,
        totalTurns: state.turnCount,
      }),
    );
  }
}
