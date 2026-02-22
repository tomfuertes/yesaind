import { tool } from "ai";
import { z } from "zod";
import { AI_USER_ID, CANVAS_MIN_X, CANVAS_MAX_X, CANVAS_MIN_Y, CANVAS_MAX_Y } from "../shared/types";
import type {
  BoardObject,
  BoardObjectProps,
  BoardObjectUpdate,
  MutateResult,
  BoardStub,
  CharacterRelationship,
  PollOption,
  TransientEffect,
} from "../shared/types";
import { computeConnectedLineGeometry, getEdgePoint, type ObjectBounds } from "../shared/connection-geometry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Visually distinct colors for AI-created objects on the dark canvas background.
 *  Mirrors CURSOR_COLORS in theme.ts - kept separate to avoid client/server coupling.
 *  KEY-DECISION 2026-02-20: Per-createSDKTools-call rotation ensures multi-entity scenes
 *  have distinct colors without requiring the LLM to specify them each time. */
const AI_PALETTE = [
  "#f87171", // red
  "#60a5fa", // blue
  "#4ade80", // green
  "#fbbf24", // yellow
  "#a78bfa", // violet
  "#f472b6", // pink
  "#34d399", // emerald
  "#fb923c", // orange
] as const;

/** Magic number defaults for tool dimensions and colors */
const TOOL_DEFAULTS = {
  sticky: { width: 200, height: 200, color: "#fbbf24" },
  rect: { width: 150, height: 100, fill: "#3b82f6", stroke: "#2563eb" },
  circle: { diameter: 100, fill: "#3b82f6", stroke: "#2563eb" },
  line: { width: 200, height: 0, stroke: "#94a3b8" },
  frame: { width: 400, height: 300 },
  image: { width: 1024, height: 1024 },
  connector: { stroke: "#94a3b8" },
  person: { width: 80, height: 120, color: "#6366f1" }, // indigo; SPARK=#fb923c, SAGE=#4ade80
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// randomPos removed in v23: replaced by flowPlace() inside createSDKTools closure

/** Create a BoardObject with standard defaults */
function makeObject(
  type: BoardObject["type"],
  pos: { x: number; y: number },
  width: number,
  height: number,
  props: BoardObjectProps,
  batchId?: string,
): BoardObject {
  // Cast: TS can't narrow type+props combo from separate args
  return {
    id: crypto.randomUUID(),
    type,
    ...pos,
    width,
    height,
    rotation: 0,
    props,
    createdBy: AI_USER_ID,
    updatedAt: Date.now(),
    ...(batchId ? { batchId } : {}),
  } as BoardObject;
}

/** Mutate (create) an object, log it, and return position info for LLM chaining */
async function createAndMutate(stub: BoardStub, obj: BoardObject) {
  let result: MutateResult;
  try {
    result = await stub.mutate({ type: "obj:create", obj });
  } catch (err) {
    console.error(JSON.stringify({ event: "ai:create:error", type: obj.type, id: obj.id, error: String(err) }));
    return { error: `Failed to create ${obj.type}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.ok) {
    console.error(JSON.stringify({ event: "ai:create:rejected", type: obj.type, id: obj.id, error: result.error }));
    return { error: result.error };
  }
  console.debug(
    JSON.stringify({
      event: "ai:create",
      type: obj.type,
      id: obj.id,
      x: obj.x,
      y: obj.y,
      w: obj.width,
      h: obj.height,
    }),
  );
  cursorToCenter(stub, obj);
  return {
    created: obj.id,
    type: obj.type,
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
  };
}

/** Mutate (update) an object's fields, returning a keyed result for LLM chaining */
async function updateAndMutate(
  stub: BoardStub,
  id: string,
  fields: Omit<BoardObjectUpdate, "id">,
  resultKey: string,
  extra?: Record<string, unknown>,
  anim?: { duration: number },
) {
  let result: MutateResult;
  try {
    result = await stub.mutate({
      type: "obj:update",
      obj: { id, ...fields, updatedAt: Date.now() },
      ...(anim ? { anim } : {}),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "ai:update:error", id, error: String(err) }));
    return { error: `Failed to update ${id}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.ok) return { error: result.error ?? "Unknown mutation error" };
  return { [resultKey]: id, ...extra };
}

/** Cascade: recalculate geometry for all lines connected to a changed object */
async function cascadeConnectedLines(stub: BoardStub, changedId: string, changedObj: ObjectBounds) {
  const allObjects = await stub.readObjects();
  for (const obj of allObjects) {
    if (obj.type !== "line") continue;
    if (obj.startObjectId !== changedId && obj.endObjectId !== changedId) continue;
    const startObj =
      obj.startObjectId === changedId
        ? changedObj
        : obj.startObjectId
          ? allObjects.find((o) => o.id === obj.startObjectId)
          : null;
    const endObj =
      obj.endObjectId === changedId
        ? changedObj
        : obj.endObjectId
          ? allObjects.find((o) => o.id === obj.endObjectId)
          : null;
    if (!startObj && !endObj) continue;
    let geo: { x: number; y: number; width: number; height: number };
    if (startObj && endObj) {
      geo = computeConnectedLineGeometry(startObj, endObj);
    } else if (startObj) {
      const endX = obj.x + obj.width;
      const endY = obj.y + obj.height;
      const edge = getEdgePoint(startObj, endX, endY);
      geo = { x: edge.x, y: edge.y, width: endX - edge.x, height: endY - edge.y };
    } else {
      const edge = getEdgePoint(endObj!, obj.x, obj.y);
      geo = { x: obj.x, y: obj.y, width: edge.x - obj.x, height: edge.y - obj.y };
    }
    await updateAndMutate(stub, obj.id, geo, "lineUpdated");
  }
}

/** Fire-and-forget: move AI cursor to object center. Never blocks tool execution. */
function cursorToCenter(stub: BoardStub, obj: { x: number; y: number; width: number; height: number }) {
  stub.injectCursor(obj.x + obj.width / 2, obj.y + obj.height / 2).catch((err: unknown) => {
    console.debug(JSON.stringify({ event: "ai:cursor:error", error: String(err) }));
  });
}

/**
 * Read an object by ID and move the AI cursor to its center.
 * Returns the object (or null). Used by move/resize/text/color tools
 * that need the existing object before mutating.
 */
async function readAndCenter(stub: BoardStub, id: string): Promise<BoardObject | null> {
  const obj = await stub.readObject(id);
  if (obj) cursorToCenter(stub, obj);
  return obj;
}

/** Check if two board objects overlap (axis-aligned bounding boxes) */
export function rectsOverlap(a: BoardObject, b: BoardObject): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Count pairwise overlaps among objects (0 = perfect layout).
 *  Frames are excluded: objects placed inside a frame are expected to overlap it visually.
 *  Lines are excluded: connector bbox always overlaps connected objects by design.
 *  KEY-DECISION 2026-02-21: frame+line exclusion prevents false positives in eval metrics
 *  for scene-setup (3 persons inside frame → 3 false overlaps without this filter). */
export function computeOverlapScore(objects: BoardObject[]): number {
  const collidable = objects.filter((o) => o.type !== "frame" && o.type !== "line");
  let overlaps = 0;
  for (let i = 0; i < collidable.length; i++)
    for (let j = i + 1; j < collidable.length; j++) if (rectsOverlap(collidable[i], collidable[j])) overlaps++;
  return overlaps;
}

/** Fraction of the smaller object's area covered by the intersection (0-1). */
function overlapFraction(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  if (intersection === 0) return 0;
  return intersection / Math.min(a.width * a.height, b.width * b.height);
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

/** Type guard: is value a non-null, non-array object (i.e. a valid JSON dict)? */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wrap a tool execute function with timing and structured logging */
function instrumentExecute<TArgs, TResult>(
  toolName: string,
  fn: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    // Guard: reject non-object inputs from malformed LLM tool calls.
    // Free-tier models (GLM-4.7-Flash) sometimes emit strings or nulls.
    if (!isPlainObject(args)) {
      const inputType = args === null ? "null" : Array.isArray(args) ? "array" : typeof args;
      console.error(
        JSON.stringify({
          event: "ai:tool:invalid-input",
          tool: toolName,
          inputType,
          input: String(args).slice(0, 200),
        }),
      );
      return {
        error: `Invalid input for ${toolName}: expected object, got ${inputType}`,
      } as unknown as TResult;
    }

    const start = Date.now();
    try {
      const result = await fn(args);
      const durationMs = Date.now() - start;
      const ok = !(result && typeof result === "object" && "error" in result);
      console.debug(
        JSON.stringify({
          event: "ai:tool",
          tool: toolName,
          durationMs,
          ok,
          ...(ok ? {} : { error: (result as Record<string, unknown>).error }),
        }),
      );
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      console.error(
        JSON.stringify({
          event: "ai:tool",
          tool: toolName,
          durationMs,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // KEY-DECISION 2026-02-20: Return error as a result object instead of rethrowing.
      // Tools that throw (e.g. stub.readObject() DO RPC failure) would otherwise bubble to the
      // AI SDK where error visibility to the LLM depends on SDK internals. Returning { error }
      // is the consistent pattern used by createAndMutate/updateAndMutate - the LLM always sees
      // a tool result it can act on (retry, inform user) rather than an opaque exception.
      return { error: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}` } as unknown as TResult;
    }
  };
}

/** Board object with LLM-irrelevant fields stripped for token savings */
type LLMBoardObject = Omit<BoardObject, "updatedAt" | "createdBy" | "batchId" | "rotation" | "isBackground"> & {
  rotation?: number;
};

/** Strip LLM-irrelevant fields from board objects to reduce token usage.
 *  Background objects should be filtered before calling this (see getBoardState). */
function stripForLLM(obj: BoardObject): LLMBoardObject {
  const { updatedAt: _updatedAt, createdBy: _createdBy, batchId: _batchId, isBackground: _bg, rotation, ...rest } = obj;
  // Strip base64 src from images (massive, useless for LLM) - keep prompt for context
  if (rest.type === "image" && rest.props.src) {
    rest.props = { ...rest.props, src: "[base64 image]" };
  }
  // Only include rotation when non-zero (meaningful)
  if (rotation) return { ...rest, rotation };
  return rest;
}

// ---------------------------------------------------------------------------
// Image generation helper (shared by generateImage tool + stage backgrounds)
// ---------------------------------------------------------------------------

/** Generate an image via CF Workers AI SDXL and return a data URL.
 *  Throws on failure - callers must handle errors. */
export async function generateImageDataUrl(ai: Ai, prompt: string): Promise<string> {
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB raw - keeps base64 under DO SQLite 2MB value limit

  const response = await ai.run(
    "@cf/stabilityai/stable-diffusion-xl-base-1.0" as Parameters<Ai["run"]>[0],
    { prompt, width: 1024, height: 1024 } as Record<string, unknown>,
  );

  if (!response || typeof (response as ReadableStream).getReader !== "function") {
    const responseType = response === null ? "null" : typeof response;
    throw new Error(`Image generation returned unexpected response type: ${responseType}`);
  }

  const stream = response as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  if (totalLen === 0) {
    throw new Error("Image generation returned empty response (0 bytes)");
  }
  if (totalLen > MAX_IMAGE_BYTES) {
    throw new Error(`Generated image too large (${(totalLen / 1024).toFixed(0)}KB)`);
  }

  const imageBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    imageBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // btoa works on latin1 strings; build from byte array
  let binary = "";
  for (let i = 0; i < imageBytes.length; i++) {
    binary += String.fromCharCode(imageBytes[i]);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/** Shared mutable ref passed across multiple createSDKTools closures in the same turn.
 *  Allows stageManager + main streamText to share a single global creation cap. */
export type CreateBudget = { used: number };

/** Shared mutable array passed across multiple createSDKTools closures in the same turn.
 *  Allows stageManager + main streamText to see each other's placed object bounds in flowPlace,
 *  preventing cross-closure overlaps (same pattern as CreateBudget shared ref). */
export type SharedBounds = Array<{ x: number; y: number; width: number; height: number }>;

/** Create the full AI SDK tool registry bound to a specific Board DO stub.
 *  @param maxCreates - per-closure object creation budget (local cap).
 *  @param createBudget - shared ref for cross-closure global cap (stageManager + main turn).
 *  @param globalMaxCreates - max total creates across all closures sharing createBudget.
 *  @param sharedBounds - shared array for cross-closure layout awareness (stageManager + main turn).
 *  @param qaMode - when true, bypasses per-turn maxCreates caps for QA stress testing. OOB clamping stays active. */
export function createSDKTools(
  stub: BoardStub,
  batchId?: string,
  ai?: Ai,
  storage?: DurableObjectStorage,
  maxCreates = 4,
  createBudget?: CreateBudget,
  globalMaxCreates?: number,
  sharedBounds?: SharedBounds,
  qaMode = false,
) {
  // Rotate through AI_PALETTE per streamText call so multi-entity scenes get distinct colors.
  // Only used as fallback when the LLM doesn't specify an explicit color.
  let paletteIndex = 0;
  const nextPaletteColor = () => AI_PALETTE[paletteIndex++ % AI_PALETTE.length];

  // KEY-DECISION 2026-02-21: Server-side layout enforcement. Per-response counters live in
  // this closure so all tool calls (including batchExecute) share the same budget without
  // changing Zod schemas or the BoardStub interface.
  // KEY-DECISION 2026-02-21: maxCreates is parameterized because createSDKTools is called 4-6
  // times per user turn (stageManager, main, reactive, director, canvas/sfx reactions). Each
  // call gets its own closure - a fixed cap of 4 allowed 6-8 objects per turn total.
  // KEY-DECISION 2026-02-21: createBudget is a shared mutable ref that lets stageManager and
  // main streamText share a global cap (~6) per turn. Out-of-band calls (reactive, sfx, canvas,
  // director) fire in separate execution contexts and keep independent closure counters.
  // KEY-DECISION 2026-02-21: sharedBounds is a shared mutable array (same pattern as
  // createBudget) that lets stageManager + main see each other's placed object bounds in
  // flowPlace. Root cause of overlap=12 on grid-2x2: stageManager creates 3 objects, main
  // flowPlace checks only its own empty aiCreatedBounds -> all 3 main objects land at origin.
  let aiCreateCount = 0;
  const MAX_AI_CREATES_PER_RESPONSE = maxCreates;
  const aiCreatedBounds: Array<{ x: number; y: number; width: number; height: number }> = [];

  // KEY-DECISION 2026-02-21: v23 - server-side auto-layout. LLMs can't do spatial reasoning;
  // stop asking for x,y. flowPlace reads existing board state and shelf-packs new objects.
  let existingBoundsCache: Array<{ x: number; y: number; width: number; height: number }> | null = null;
  async function getExistingBounds() {
    if (existingBoundsCache === null) {
      const objects = await stub.readObjects();
      existingBoundsCache = objects
        .filter((o: BoardObject) => o.type !== "line" && o.type !== "image" && !o.isBackground)
        .map((o: BoardObject) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
    }
    return existingBoundsCache;
  }

  // Frame-aware placement: when a frame is created, subsequent objects go inside it
  let currentFrame: { x: number; y: number; width: number; height: number } | null = null;

  /** Check if a candidate rectangle is clear of all existing bounds with a gap margin.
   *  Combines overlapFraction (interior overlap) + AABB-with-gap (touching edges) checks. */
  function isClear(
    candidate: { x: number; y: number; width: number; height: number },
    allBounds: Array<{ x: number; y: number; width: number; height: number }>,
    gap: number,
  ): boolean {
    return (
      !allBounds.some((b) => overlapFraction(candidate, b) > 0) &&
      !allBounds.some(
        (b) =>
          candidate.x < b.x + b.width + gap &&
          candidate.x + candidate.width + gap > b.x &&
          candidate.y < b.y + b.height + gap &&
          candidate.y + candidate.height + gap > b.y,
      )
    );
  }

  /** Flow-place an object on the canvas, avoiding all existing + same-turn objects.
   *  When hint is provided (and no currentFrame), tries the hinted position first, then
   *  spirals outward via Chebyshev rings to find the nearest clear slot.
   *  KEY-DECISION 2026-02-21: two-pass scan eliminates the "place at origin" fallback that
   *  caused overlap=12 on dense scenes. Pass 1: coarse grid (fast, covers most cases). Pass 2
   *  (fallback): fine-grained scan from below the tallest existing content, guaranteeing a
   *  clear position as long as the canvas has any vertical space left.
   *  KEY-DECISION 2026-02-22: hint support re-introduces optional positional intent from LLMs.
   *  Server validates and corrects via collision avoidance - LLM hints, server decides. */
  async function flowPlace(
    width: number,
    height: number,
    hint?: { x: number; y: number },
  ): Promise<{ x: number; y: number }> {
    const GAP = 16;
    const existing = await getExistingBounds();
    // Include sharedBounds (cross-closure: stageManager objects visible to main and vice versa)
    const allBounds = [...existing, ...aiCreatedBounds, ...(sharedBounds ?? [])];

    // Hint-based placement: try hinted position first, then spiral outward.
    // Ignored when currentFrame is set (frame-local semantics take priority).
    if (hint && !currentFrame) {
      // OOB clamp the hint to canvas bounds
      const hx = Math.max(CANVAS_MIN_X, Math.min(hint.x, CANVAS_MAX_X - width));
      const hy = Math.max(CANVAS_MIN_Y, Math.min(hint.y, CANVAS_MAX_Y - height));

      // Direct check - if clamped position is clear, use it (zero cost)
      const direct = { x: hx, y: hy, width, height };
      if (isClear(direct, allBounds, GAP)) {
        console.debug(JSON.stringify({ event: "ai:flowplace:hint", hint, result: { x: hx, y: hy }, spiralRadius: 0 }));
        return { x: hx, y: hy };
      }

      // Chebyshev spiral outward from hint - expanding square rings
      const STEP = Math.max(16, Math.floor(Math.min(width, height) / 2));
      const MAX_RADIUS = Math.max(CANVAS_MAX_X - CANVAS_MIN_X, CANVAS_MAX_Y - CANVAS_MIN_Y);
      for (let r = STEP; r <= MAX_RADIUS; r += STEP) {
        // Walk the perimeter of the square ring at distance r
        for (let dx = -r; dx <= r; dx += STEP) {
          for (const dy of [-r, r]) {
            const cx = Math.max(CANVAS_MIN_X, Math.min(hx + dx, CANVAS_MAX_X - width));
            const cy = Math.max(CANVAS_MIN_Y, Math.min(hy + dy, CANVAS_MAX_Y - height));
            if (isClear({ x: cx, y: cy, width, height }, allBounds, GAP)) {
              console.debug(
                JSON.stringify({ event: "ai:flowplace:hint", hint, result: { x: cx, y: cy }, spiralRadius: r }),
              );
              return { x: cx, y: cy };
            }
          }
        }
        // Vertical edges of the ring (skip corners already checked above)
        for (let dy = -r + STEP; dy < r; dy += STEP) {
          for (const dx of [-r, r]) {
            const cx = Math.max(CANVAS_MIN_X, Math.min(hx + dx, CANVAS_MAX_X - width));
            const cy = Math.max(CANVAS_MIN_Y, Math.min(hy + dy, CANVAS_MAX_Y - height));
            if (isClear({ x: cx, y: cy, width, height }, allBounds, GAP)) {
              console.debug(
                JSON.stringify({ event: "ai:flowplace:hint", hint, result: { x: cx, y: cy }, spiralRadius: r }),
              );
              return { x: cx, y: cy };
            }
          }
        }
      }
      // Spiral exhausted - fall through to standard flowPlace algorithm
      console.debug(JSON.stringify({ event: "ai:flowplace:hint-exhausted", hint, fallback: "flowPlace" }));
    }

    // Frame-local placement: objects created after a frame go inside it
    if (currentFrame) {
      const INSET = 16;
      const TITLE_H = 28; // space for frame title bar
      const fMinX = currentFrame.x + INSET;
      const fMinY = currentFrame.y + TITLE_H;
      const fMaxX = currentFrame.x + currentFrame.width - INSET;
      const fMaxY = currentFrame.y + currentFrame.height - INSET;

      // Exclude the current frame from overlap checks (we're placing inside it)
      const innerBounds = allBounds.filter(
        (b) =>
          !(
            b.x === currentFrame!.x &&
            b.y === currentFrame!.y &&
            b.width === currentFrame!.width &&
            b.height === currentFrame!.height
          ),
      );

      for (let cy = fMinY; cy + height <= fMaxY; cy += height + GAP) {
        for (let cx = fMinX; cx + width <= fMaxX; cx += width + GAP) {
          if (isClear({ x: cx, y: cy, width, height }, innerBounds, GAP)) {
            return { x: cx, y: cy };
          }
        }
      }
      // Frame full - fall through to canvas-level placement
      currentFrame = null;
    }

    // --- Pass 1: coarse grid scan (object-sized steps, efficient) ---
    for (let cy = CANVAS_MIN_Y; cy + height <= CANVAS_MAX_Y; cy += height + GAP) {
      for (let cx = CANVAS_MIN_X; cx + width <= CANVAS_MAX_X; cx += width + GAP) {
        if (isClear({ x: cx, y: cy, width, height }, allBounds, GAP)) {
          return { x: cx, y: cy };
        }
      }
    }

    // --- Pass 2: fine-grained fallback below all existing content ---
    // The coarse grid can miss valid positions when existing objects have irregular sizes.
    // Find the Y coordinate below the bottom edge of all placed objects, then scan right-to-left
    // at a fine step (half object height) to find the nearest clear slot.
    // KEY-DECISION 2026-02-21: this prevents the "canvas full" fallback from placing objects
    // at origin (CANVAS_MIN_X, CANVAS_MIN_Y) which guarantees overlap when content is there.
    const FINE_STEP_X = Math.max(8, Math.floor(width / 4));
    const FINE_STEP_Y = Math.max(8, Math.floor(height / 4));
    const contentMaxY = allBounds.reduce((m, b) => Math.max(m, b.y + b.height), CANVAS_MIN_Y - 1);
    const fallbackStartY = Math.min(contentMaxY + GAP, CANVAS_MAX_Y - height);
    if (fallbackStartY + height <= CANVAS_MAX_Y) {
      for (let cy = fallbackStartY; cy + height <= CANVAS_MAX_Y; cy += FINE_STEP_Y) {
        for (let cx = CANVAS_MIN_X; cx + width <= CANVAS_MAX_X; cx += FINE_STEP_X) {
          if (isClear({ x: cx, y: cy, width, height }, allBounds, GAP)) {
            return { x: cx, y: cy };
          }
        }
      }
    }

    // Canvas truly full - place at origin (OOB clamping handles bounds).
    // Should only happen when the canvas has more objects than it can fit.
    return { x: CANVAS_MIN_X, y: CANVAS_MIN_Y };
  }

  /**
   * Wraps createAndMutate with count cap + OOB clamping.
   * Position should already be set by flowPlace() before calling this.
   */
  async function enforcedCreate(obj: BoardObject) {
    if (!qaMode) {
      // Local per-closure cap - return success-shaped result so LLM doesn't retry
      if (aiCreateCount >= MAX_AI_CREATES_PER_RESPONSE) {
        console.log(
          JSON.stringify({
            event: "ai:create:capped",
            objType: obj.type,
            localCount: aiCreateCount,
            localMax: MAX_AI_CREATES_PER_RESPONSE,
            globalUsed: createBudget?.used,
            globalMax: globalMaxCreates,
          }),
        );
        return {
          created: obj.id,
          type: obj.type,
          x: obj.x,
          y: obj.y,
          width: obj.width,
          height: obj.height,
          capped: true,
        };
      }

      // Global cross-closure cap (shared between stageManager + main streamText)
      if (createBudget && globalMaxCreates !== undefined && createBudget.used >= globalMaxCreates) {
        console.log(
          JSON.stringify({
            event: "ai:create:capped",
            objType: obj.type,
            localCount: aiCreateCount,
            localMax: MAX_AI_CREATES_PER_RESPONSE,
            globalUsed: createBudget?.used,
            globalMax: globalMaxCreates,
          }),
        );
        return {
          created: obj.id,
          type: obj.type,
          x: obj.x,
          y: obj.y,
          width: obj.width,
          height: obj.height,
          capped: true,
        };
      }
    }

    // OOB clamping - ensure object stays fully within canvas bounds (active even in qaMode)
    obj.x = Math.max(CANVAS_MIN_X, Math.min(obj.x, CANVAS_MAX_X - obj.width));
    obj.y = Math.max(CANVAS_MIN_Y, Math.min(obj.y, CANVAS_MAX_Y - obj.height));

    if (qaMode) {
      console.log(JSON.stringify({ event: "ai:create:qa-bypass", objType: obj.type, count: aiCreateCount }));
    }

    const result = await createAndMutate(stub, obj);
    if (!("error" in result)) {
      if (obj.type !== "line" && obj.type !== "image") {
        const bounds = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
        aiCreatedBounds.push(bounds);
        sharedBounds?.push(bounds);
      }
      aiCreateCount++;
      if (createBudget) createBudget.used++;
      console.log(
        JSON.stringify({
          event: "ai:create:ok",
          objType: obj.type,
          localCount: aiCreateCount,
          globalUsed: createBudget?.used,
        }),
      );
    }
    return result;
  }

  const baseTools = {
    // 1. createStickyNote
    createStickyNote: tool({
      description:
        "Create a sticky note (colored card) on the whiteboard. Use sparingly - only when the player " +
        "explicitly requests sticky notes or card-based layouts. For action words, exclamations, dialogue, " +
        "narration, and labels, prefer createText instead. " +
        "Position is auto-placed by the layout engine. Optionally provide x,y hints for preferred placement.",
      inputSchema: z.object({
        text: z.string().describe("The text content of the sticky note"),
        color: z
          .string()
          .optional()
          .describe(
            "Hex color (default: #fbbf24 yellow). Options: #fbbf24, #f87171, #4ade80, #60a5fa, #c084fc, #fb923c",
          ),
        x: z
          .number()
          .optional()
          .describe(
            "Preferred X position (canvas: 50-1150). Server enforces collision avoidance - final position may differ.",
          ),
        y: z
          .number()
          .optional()
          .describe(
            "Preferred Y position (canvas: 60-780). Server enforces collision avoidance - final position may differ.",
          ),
      }),
      execute: instrumentExecute("createStickyNote", async ({ text, color, x, y }) => {
        const hint = x !== undefined && y !== undefined ? { x, y } : undefined;
        const pos = await flowPlace(TOOL_DEFAULTS.sticky.width, TOOL_DEFAULTS.sticky.height, hint);
        const obj = makeObject(
          "sticky",
          pos,
          TOOL_DEFAULTS.sticky.width,
          TOOL_DEFAULTS.sticky.height,
          {
            text: text || "New note",
            color: color || nextPaletteColor(),
          },
          batchId,
        );
        return enforcedCreate(obj);
      }),
    }),

    // 2. createPerson
    createPerson: tool({
      description:
        "Place a character (stick figure) on the canvas with a name label above their head. " +
        "Use for scene characters, players, NPCs, and crowd members. " +
        "Use persona colors for AI characters: SPARK=#fb923c, SAGE=#4ade80. " +
        "Prefer createPerson over drawScene for human characters. " +
        "Position is auto-placed by the layout engine. Optionally provide x,y hints for preferred placement.",
      inputSchema: z.object({
        name: z.string().describe("Character name shown above the figure (e.g. 'Dr. Fang', 'The Patient', 'Nurse')"),
        color: z
          .string()
          .optional()
          .describe(
            "Figure color hex (default: #6366f1 indigo). SPARK=#fb923c, SAGE=#4ade80. Use player color to represent a specific user.",
          ),
        x: z
          .number()
          .optional()
          .describe(
            "Preferred X position (canvas: 50-1150). Server enforces collision avoidance - final position may differ.",
          ),
        y: z
          .number()
          .optional()
          .describe(
            "Preferred Y position (canvas: 60-780). Server enforces collision avoidance - final position may differ.",
          ),
      }),
      execute: instrumentExecute("createPerson", async ({ name, color, x, y }) => {
        const hint = x !== undefined && y !== undefined ? { x, y } : undefined;
        const pos = await flowPlace(TOOL_DEFAULTS.person.width, TOOL_DEFAULTS.person.height, hint);
        const obj = makeObject(
          "person",
          pos,
          TOOL_DEFAULTS.person.width,
          TOOL_DEFAULTS.person.height,
          {
            text: typeof name === "string" && name.trim() ? name.trim() : "Character",
            color: color || nextPaletteColor(),
          },
          batchId,
        );
        return enforcedCreate(obj);
      }),
    }),

    // 3. createShape (rect, circle, line)
    createShape: tool({
      description:
        "Create a shape on the whiteboard. Use shape='rect' for rectangle, 'circle' for circle, 'line' for line. " +
        "Position is auto-placed by the layout engine. Optionally provide x,y hints for preferred placement.",
      inputSchema: z.object({
        shape: z.string().describe("Shape type: 'rect', 'circle', or 'line'"),
        width: z
          .number()
          .optional()
          .describe("Width (default: 150). For circle: diameter. For line: X delta to endpoint."),
        height: z
          .number()
          .optional()
          .describe("Height (default: 100). For circle: same as width. For line: Y delta to endpoint."),
        fill: z.string().optional().describe("Fill color hex (default: #3b82f6)"),
        stroke: z.string().optional().describe("Stroke color hex (default: #2563eb)"),
        x: z
          .number()
          .optional()
          .describe(
            "Preferred X position (canvas: 50-1150). Server enforces collision avoidance - final position may differ.",
          ),
        y: z
          .number()
          .optional()
          .describe(
            "Preferred Y position (canvas: 60-780). Server enforces collision avoidance - final position may differ.",
          ),
      }),
      execute: instrumentExecute("createShape", async ({ shape: shapeArg, width, height, fill, stroke, x, y }) => {
        const shape = shapeArg || "rect";
        const hint = x !== undefined && y !== undefined ? { x, y } : undefined;

        if (shape === "circle") {
          const diameter = width ?? TOOL_DEFAULTS.circle.diameter;
          const pos = await flowPlace(diameter, diameter, hint);
          const palFill = fill || nextPaletteColor();
          const obj = makeObject(
            "circle",
            pos,
            diameter,
            diameter,
            { fill: palFill, stroke: stroke || palFill },
            batchId,
          );
          return enforcedCreate(obj);
        }

        if (shape === "line") {
          const lineW = width ?? TOOL_DEFAULTS.line.width;
          const lineH = height ?? TOOL_DEFAULTS.line.height;
          const pos = await flowPlace(lineW, Math.max(lineH, 4), hint);
          const obj = makeObject("line", pos, lineW, lineH, { stroke: stroke || TOOL_DEFAULTS.line.stroke }, batchId);
          return enforcedCreate(obj);
        }

        // Default: rect
        const rectW = width ?? TOOL_DEFAULTS.rect.width;
        const rectH = height ?? TOOL_DEFAULTS.rect.height;
        const pos = await flowPlace(rectW, rectH, hint);
        const palFill = fill || nextPaletteColor();
        const obj = makeObject("rect", pos, rectW, rectH, { fill: palFill, stroke: stroke || palFill }, batchId);
        return enforcedCreate(obj);
      }),
    }),

    // 3. createFrame
    createFrame: tool({
      description:
        "Create a frame (labeled container/region) on the whiteboard to group or organize objects. Frames render behind other objects. " +
        "Position is auto-placed by the layout engine. Optionally provide x,y hints for preferred placement.",
      inputSchema: z.object({
        title: z.string().describe("The frame title/label"),
        width: z.number().optional().describe("Width in pixels (default: 400)"),
        height: z.number().optional().describe("Height in pixels (default: 300)"),
        x: z
          .number()
          .optional()
          .describe(
            "Preferred X position (canvas: 50-1150). Server enforces collision avoidance - final position may differ.",
          ),
        y: z
          .number()
          .optional()
          .describe(
            "Preferred Y position (canvas: 60-780). Server enforces collision avoidance - final position may differ.",
          ),
      }),
      execute: instrumentExecute("createFrame", async ({ title, width, height, x, y }) => {
        const frameW = width ?? TOOL_DEFAULTS.frame.width;
        const frameH = height ?? TOOL_DEFAULTS.frame.height;
        const hint = x !== undefined && y !== undefined ? { x, y } : undefined;
        const pos = await flowPlace(frameW, frameH, hint);
        const obj = makeObject(
          "frame",
          pos,
          frameW,
          frameH,
          {
            text: typeof title === "string" && title.trim() ? title.trim() : "Frame",
          },
          batchId,
        );
        const result = await enforcedCreate(obj);
        // KEY-DECISION 2026-02-22: Only set currentFrame when the frame was actually persisted.
        // Capped frames (budget exhausted) return success-shaped data but nothing is on the board.
        // A phantom currentFrame would place subsequent objects inside an invisible area, causing
        // them to land in positions that overlap other content.
        if (!("error" in result) && !("capped" in result)) {
          // Track frame for subsequent in-frame placement
          currentFrame = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
        }
        return result;
      }),
    }),

    // 4. createConnector (resolves object centers server-side)
    createConnector: tool({
      description:
        "Create a connector/arrow between two objects on the whiteboard. Pass the IDs of the objects to connect.",
      inputSchema: z.object({
        fromId: z.string().describe("ID of the source object"),
        toId: z.string().describe("ID of the target object"),
        stroke: z.string().optional().describe("Stroke color hex (default: #94a3b8)"),
        arrow: z.string().optional().describe("Arrow style: 'end' (default), 'both', or 'none'"),
      }),
      execute: instrumentExecute("createConnector", async ({ fromId, toId, stroke, arrow }) => {
        const fromObj = await stub.readObject(fromId);
        const toObj = await stub.readObject(toId);
        if (!fromObj) return { error: `Source object ${fromId} not found` };
        if (!toObj) return { error: `Target object ${toId} not found` };

        // Edge-snapped geometry instead of center-to-center
        const geo = computeConnectedLineGeometry(fromObj, toObj);
        if (geo.width === 0 && geo.height === 0) {
          return { error: "Cannot create zero-length connector (objects overlap)" };
        }

        const arrowStyle = arrow === "both" ? "both" : arrow === "none" ? "none" : "end";
        const obj = makeObject(
          "line",
          { x: geo.x, y: geo.y },
          geo.width,
          geo.height,
          {
            stroke: stroke || TOOL_DEFAULTS.connector.stroke,
            arrow: arrowStyle as "end" | "both" | "none",
          },
          batchId,
        );
        // Store connection bindings so lines follow when objects move
        obj.startObjectId = fromId;
        obj.endObjectId = toId;
        const result = await enforcedCreate(obj);
        if ("error" in result) return result;
        return { ...result, from: fromId, to: toId };
      }),
    }),

    // 5. moveObject
    moveObject: tool({
      description: "Move an existing object to a new position on the whiteboard",
      inputSchema: z.object({
        id: z.string().describe("The ID of the object to move"),
        x: z.number().describe("New X position"),
        y: z.number().describe("New Y position"),
        duration: z.number().optional().describe("Animation duration in ms, default 500"),
      }),
      execute: instrumentExecute("moveObject", async ({ id, x, y, duration }) => {
        const existing = await readAndCenter(stub, id);
        if (existing) cursorToCenter(stub, { x, y, width: existing.width, height: existing.height });
        const result = await updateAndMutate(stub, id, { x, y }, "moved", { x, y }, { duration: duration ?? 500 });
        if ("error" in result) return result;

        // Cascade: update connected lines
        if (existing) await cascadeConnectedLines(stub, id, { ...existing, x, y });
        return result;
      }),
    }),

    // 6. resizeObject
    resizeObject: tool({
      description: "Resize an existing object on the whiteboard",
      inputSchema: z.object({
        id: z.string().describe("The ID of the object to resize"),
        width: z.number().describe("New width"),
        height: z.number().describe("New height"),
        duration: z.number().optional().describe("Animation duration in ms, default 500"),
      }),
      execute: instrumentExecute("resizeObject", async ({ id, width, height, duration }) => {
        const existing = await readAndCenter(stub, id);
        if (existing) cursorToCenter(stub, { x: existing.x, y: existing.y, width, height });
        const result = await updateAndMutate(
          stub,
          id,
          { width, height },
          "resized",
          { width, height },
          { duration: duration ?? 500 },
        );
        if ("error" in result) return result;

        // Cascade: update connected lines
        if (existing) await cascadeConnectedLines(stub, id, { ...existing, width, height });
        return result;
      }),
    }),

    // 7. updateText
    updateText: tool({
      description: "Update the text content of a sticky note, text object, or frame title",
      inputSchema: z.object({
        id: z.string().describe("The ID of the object to update"),
        text: z.string().describe("New text content"),
      }),
      execute: instrumentExecute("updateText", async ({ id, text }) => {
        await readAndCenter(stub, id);
        return updateAndMutate(stub, id, { props: { text } }, "updated", { text });
      }),
    }),

    // 8. changeColor
    changeColor: tool({
      description: "Change the color of an object. Maps to props.color for stickies, props.fill for shapes.",
      inputSchema: z.object({
        id: z.string().describe("The ID of the object to recolor"),
        color: z.string().describe("New hex color"),
      }),
      execute: instrumentExecute("changeColor", async ({ id, color }) => {
        const existing = await readAndCenter(stub, id);
        if (!existing) return { error: `Object ${id} not found` };
        const props: BoardObjectProps =
          existing.type === "sticky" || existing.type === "text"
            ? { color }
            : existing.type === "line"
              ? { stroke: color }
              : { fill: color };
        return updateAndMutate(stub, id, { props }, "recolored", { color });
      }),
    }),

    // 9. getBoardState (with filtering, summary mode, overlap scoring, and sense param)
    getBoardState: tool({
      description:
        "Read objects on the whiteboard. Optionally filter by type or specific IDs. For large boards (20+), returns a summary unless filtered. " +
        "Use `sense` to scope the response: 'characters' returns only person-type objects; 'recent' returns objects updated in the last 2 minutes; " +
        "'spatial' returns full x/y/width/height for choreograph or layout reasoning; 'all' (default) is current behavior.",
      inputSchema: z.object({
        filter: z
          .string()
          .optional()
          .describe("Filter by object type: 'sticky', 'rect', 'circle', 'line', 'text', 'frame', 'image', 'person'"),
        ids: z.array(z.string()).optional().describe("Array of specific object IDs to return"),
        sense: z
          .enum(["all", "characters", "recent", "spatial"])
          .optional()
          .describe(
            "Scope of response: 'all' (default) returns everything; 'characters' returns only person objects; " +
              "'recent' returns objects updated in the last 2 minutes; 'spatial' includes x/y/width/height for layout reasoning.",
          ),
      }),
      execute: instrumentExecute("getBoardState", async ({ filter, ids, sense }) => {
        const allObjects = await stub.readObjects();
        // Exclude background images from AI context (decorative, huge base64)
        let objects = allObjects.filter((o: BoardObject) => !o.isBackground);

        // Apply sense-based pre-filters before id/type filters
        if (sense === "characters") {
          objects = objects.filter((o: BoardObject) => o.type === "person");
        } else if (sense === "recent") {
          const cutoff = Date.now() - 2 * 60 * 1000;
          objects = objects.filter((o: BoardObject) => o.updatedAt >= cutoff);
        }

        if (ids && ids.length > 0) {
          return objects.filter((o: BoardObject) => ids.includes(o.id)).map(stripForLLM);
        }

        if (filter) {
          return objects.filter((o: BoardObject) => o.type === filter).map(stripForLLM);
        }

        // Compute and log overlap score for observability
        const overlapScore = computeOverlapScore(objects);
        if (overlapScore > 0) {
          console.debug(
            JSON.stringify({
              event: "ai:overlap",
              score: overlapScore,
              total: objects.length,
            }),
          );
        }

        // spatial sense: skip summary threshold so AI gets full coordinates
        if (sense === "spatial") {
          return objects.map(stripForLLM);
        }

        if (objects.length >= 20) {
          const counts: Record<string, number> = {};
          for (const o of objects) counts[o.type] = (counts[o.type] || 0) + 1;
          return {
            summary: true,
            total: objects.length,
            countsByType: counts,
            overlapScore,
            hint: "Use filter, ids, or sense parameter to get specific objects",
          };
        }

        return objects.map(stripForLLM);
      }),
    }),

    // 10. deleteObject
    deleteObject: tool({
      description: "Delete an object from the whiteboard by its ID",
      inputSchema: z.object({
        id: z.string().describe("The ID of the object to delete"),
      }),
      execute: instrumentExecute("deleteObject", async ({ id }) => {
        let result: MutateResult;
        try {
          result = await stub.mutate({ type: "obj:delete", id });
        } catch (err) {
          console.error(JSON.stringify({ event: "ai:delete:error", id, error: String(err) }));
          return { error: `Failed to delete ${id}: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (!result.ok) return { error: result.error };
        return { deleted: id };
      }),
    }),

    // 11. generateImage
    generateImage: tool({
      description:
        "Generate an AI image from a text prompt and place it on the whiteboard. Uses Stable Diffusion XL. Great for illustrations, scene backdrops, character portraits, props, etc.",
      inputSchema: z.object({
        prompt: z.string().describe("Text description of the image to generate (be specific and descriptive)"),
        width: z.number().optional().describe("Display width on the board in pixels (default: 512)"),
        height: z.number().optional().describe("Display height on the board in pixels (default: 512)"),
      }),
      execute: instrumentExecute("generateImage", async ({ prompt, width, height }) => {
        if (!ai) {
          return { error: "Image generation unavailable (AI binding not configured)" };
        }

        let src: string;
        try {
          src = await generateImageDataUrl(ai, prompt);
        } catch (err) {
          console.error(
            JSON.stringify({ event: "ai:image:generate-error", prompt: prompt.slice(0, 100), error: String(err) }),
          );
          return { error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` };
        }

        const displayW = width ?? TOOL_DEFAULTS.image.width;
        const displayH = height ?? TOOL_DEFAULTS.image.height;
        const isBackdrop = displayW >= 800 && displayH >= 600;
        if (isBackdrop) {
          // Full-canvas backdrop: pin to canvas origin, mark as background, skip budget
          const obj = makeObject(
            "image",
            { x: CANVAS_MIN_X, y: CANVAS_MIN_Y },
            displayW,
            displayH,
            { src, prompt },
            batchId,
          );
          obj.isBackground = true;
          return createAndMutate(stub, obj);
        }
        const pos = await flowPlace(displayW, displayH);
        const obj = makeObject("image", pos, displayW, displayH, { src, prompt }, batchId);
        return enforcedCreate(obj);
      }),
    }),

    // 12. createText
    createText: tool({
      description:
        "Create a text label on the whiteboard. DEFAULT for dialogue, narration, labels, descriptions, captions, " +
        "character speech, scene text, and names. Prefer this over createStickyNote for virtually all text content. " +
        "Only use createStickyNote when the colored card background adds visual meaning (action words, exclamations). " +
        "Position is auto-placed by the layout engine. Optionally provide x,y hints for preferred placement.",
      inputSchema: z.object({
        text: z.string().describe("The text content"),
        color: z.string().optional().describe("Text color hex (default: #1a1a2e)"),
        x: z
          .number()
          .optional()
          .describe(
            "Preferred X position (canvas: 50-1150). Server enforces collision avoidance - final position may differ.",
          ),
        y: z
          .number()
          .optional()
          .describe(
            "Preferred Y position (canvas: 60-780). Server enforces collision avoidance - final position may differ.",
          ),
      }),
      execute: instrumentExecute("createText", async ({ text, color, x, y }) => {
        const charWidth = 8; // ~8px per char at default 16px font
        const width = Math.max(40, text.length * charWidth + 16);
        const height = 24;
        const hintPos = x !== undefined && y !== undefined ? { x, y } : undefined;
        const pos = await flowPlace(width, height, hintPos);
        const obj = makeObject("text", pos, width, height, { text, color: color || "#1a1a2e" }, batchId);
        return enforcedCreate(obj);
      }),
    }),

    // 13. highlightObject
    highlightObject: tool({
      description:
        "Apply a transient visual effect to an existing object for dramatic emphasis. " +
        "pulse: brief scale-up bounce. shake: rapid side-to-side jitter. flash: opacity blink.",
      inputSchema: z.object({
        id: z.string().describe("ID of the object to highlight"),
        effect: z.enum(["pulse", "shake", "flash"]).describe("Effect type: 'pulse', 'shake', or 'flash'"),
      }),
      execute: instrumentExecute("highlightObject", async ({ id, effect }) => {
        await readAndCenter(stub, id);
        const result = await stub.mutate({ type: "obj:effect", id, effect });
        if (!result.ok) return { error: result.error };
        return { highlighted: id, effect };
      }),
    }),

    // 14. setRelationship
    setRelationship: tool({
      description:
        "Record or update a relationship between two characters or entities in the scene. " +
        "Call when characters first meaningfully interact or when a relationship changes. " +
        "Max 1 setRelationship call per exchange. Use character names as they appear on canvas.",
      inputSchema: z.object({
        entityA: z.string().describe("First character/entity name"),
        entityB: z.string().describe("Second character/entity name"),
        descriptor: z
          .string()
          .describe("Relationship descriptor (e.g. 'rivals', 'reluctant allies', 'secretly siblings')"),
      }),
      execute: instrumentExecute("setRelationship", async ({ entityA, entityB, descriptor }) => {
        if (!storage) return { error: "Narrative storage unavailable" };

        const existing = (await storage.get<CharacterRelationship[]>("narrative:relationships")) ?? [];

        // Upsert: match on pair in either order
        const idx = existing.findIndex(
          (r) => (r.entityA === entityA && r.entityB === entityB) || (r.entityA === entityB && r.entityB === entityA),
        );

        const updated: CharacterRelationship = { entityA, entityB, descriptor, updatedAt: Date.now() };
        let next: CharacterRelationship[];
        if (idx !== -1) {
          next = [...existing];
          next[idx] = updated;
        } else {
          // Cap at 12 relationships (keep most recent)
          next = [...existing.slice(-11), updated];
        }

        await storage.put("narrative:relationships", next);
        return { relationship: `${entityA} & ${entityB}: ${descriptor}` };
      }),
    }),

    // 15. advanceScenePhase
    advanceScenePhase: tool({
      description:
        "Advance the scene to the next lifecycle phase. Call when the scene naturally transitions. " +
        "Phases in order: establish -> build -> peak -> resolve -> curtain. " +
        "Only call at genuine phase transitions - do not skip phases or regress.",
      inputSchema: z.object({
        phase: z
          .enum(["establish", "build", "peak", "resolve", "curtain"])
          .describe("Target phase to advance to (must be later than current phase)"),
        reason: z.string().describe("Brief reason for advancing (e.g. 'All characters introduced, complications set')"),
      }),
      execute: instrumentExecute("advanceScenePhase", async ({ phase, reason }) => {
        if (!storage) return { error: "Lifecycle storage unavailable" };
        await storage.put("scene:lifecyclePhase", phase);
        console.debug(JSON.stringify({ event: "lifecycle:advance", phase, reason }));
        return { advanced: phase, reason };
      }),
    }),

    // 16. choreograph
    choreograph: tool({
      description:
        "Play a sequenced animation across multiple objects. Steps execute at their specified delay from sequence start. " +
        "Use for dramatic scene moments: characters walking in, objects falling, reveal sequences. " +
        "action='move' animates the object to (x,y). action='effect' applies a transient visual effect. " +
        "delayMs is cumulative from sequence start (e.g. 0, 500, 1000 for a 3-beat sequence). Max 20 steps.",
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              objectId: z.string().describe("ID of the object to animate"),
              action: z.enum(["move", "effect"]).describe("'move' to animate position, 'effect' for visual effect"),
              x: z.number().optional().describe("Target X position (required for move, canvas 50-1150)"),
              y: z.number().optional().describe("Target Y position (required for move, canvas 60-780)"),
              effect: z
                .enum(["pulse", "shake", "flash"])
                .optional()
                .describe("Effect type (required for effect action)"),
              delayMs: z.number().describe("Delay from sequence start in ms (0 = immediate, 500, 1000, ...)"),
            }),
          )
          .min(2)
          .max(20)
          .describe("Ordered animation steps with timing"),
      }),
      execute: instrumentExecute("choreograph", async ({ steps }) => {
        const result = await stub.mutate({ type: "obj:sequence", steps });
        if (!result.ok) return { error: result.error };
        console.debug(JSON.stringify({ event: "ai:choreograph", stepCount: steps.length }));
        return { sequenced: steps.length };
      }),
    }),

    // 17. spotlight
    spotlight: tool({
      description:
        "Dim the entire canvas and shine a spotlight on a specific object or canvas position. " +
        "Use for dramatic reveals - it draws focus to one element by darkening everything else. " +
        "Use sparingly for maximum theatrical impact. Auto-clears after 5 seconds.",
      inputSchema: z.object({
        objectId: z.string().optional().describe("ID of object to spotlight (centers the light on it)"),
        x: z.number().optional().describe("X coordinate to spotlight (used if no objectId)"),
        y: z.number().optional().describe("Y coordinate to spotlight (used if no objectId)"),
      }),
      execute: instrumentExecute("spotlight", async ({ objectId, x, y }) => {
        let spotX = x;
        let spotY = y;
        if (objectId) {
          const obj = await stub.readObject(objectId);
          if (obj) {
            spotX = obj.x + obj.width / 2;
            spotY = obj.y + obj.height / 2;
            cursorToCenter(stub, obj);
          }
        }
        const result = await stub.mutate({ type: "spotlight", objectId, x: spotX, y: spotY });
        if (!result.ok) return { error: result.error };
        return { spotlight: objectId ?? "position", x: spotX, y: spotY };
      }),
    }),

    // 18. blackout
    blackout: tool({
      description:
        "Fade the entire canvas to black for a dramatic scene transition. " +
        "Use between major scene shifts - the blackout holds for 1.5 seconds then fades out. " +
        "Use sparingly (once per scene transition maximum) for maximum theatrical impact.",
      inputSchema: z.object({}),
      execute: instrumentExecute("blackout", async () => {
        const result = await stub.mutate({ type: "blackout" });
        if (!result.ok) return { error: result.error };
        return { blackout: true };
      }),
    }),

    // 19. drawScene
    drawScene: tool({
      description:
        "Compose a visual character or object from 2-10 shapes in a bounding box. Uses proportional " +
        "coordinates (0-1) so you think in relative positions, not pixels. Auto-creates a text label. " +
        "Canvas position is auto-placed. Optionally provide x,y hints for preferred placement. " +
        "Example snowman at (300,200) 150x250: " +
        'parts:[{shape:"circle",relX:0.5,relY:0.75,relW:0.9,relH:0.35,fill:"#fff"},' +
        '{shape:"circle",relX:0.5,relY:0.4,relW:0.6,relH:0.25,fill:"#fff"},' +
        '{shape:"circle",relX:0.5,relY:0.15,relW:0.3,relH:0.12,fill:"#333"},' +
        '{shape:"rect",relX:0.5,relY:0.08,relW:0.45,relH:0.04,fill:"#333"}]',
      inputSchema: z.object({
        label: z.string().describe("What this represents (auto-creates a text label below)"),
        width: z.number().optional().describe("Bounding box width in pixels (default: 200)"),
        height: z.number().optional().describe("Bounding box height in pixels (default: 300)"),
        x: z
          .number()
          .optional()
          .describe(
            "Preferred X position (canvas: 50-1150). Server enforces collision avoidance - final position may differ.",
          ),
        y: z
          .number()
          .optional()
          .describe(
            "Preferred Y position (canvas: 60-780). Server enforces collision avoidance - final position may differ.",
          ),
        parts: z
          .array(
            z.object({
              shape: z.enum(["rect", "circle", "line"]).describe("Shape type"),
              relX: z.number().describe("Center X as 0-1 fraction of bounding box"),
              relY: z.number().describe("Center Y as 0-1 fraction of bounding box"),
              relW: z.number().describe("Width as 0-1 fraction of bounding box"),
              relH: z.number().optional().describe("Height as 0-1 fraction (default: same as relW)"),
              fill: z.string().optional().describe("Fill color hex"),
              stroke: z.string().optional().describe("Stroke color hex"),
            }),
          )
          .min(2)
          .max(10)
          .describe("Shape parts with proportional coordinates"),
      }),
      execute: instrumentExecute("drawScene", async ({ label, width, height, x, y, parts }) => {
        const w = width ?? 200;
        const h = height ?? 300;

        // Count cap: entire composition counts as 1 create (check local + global; skipped in qaMode)
        if (!qaMode) {
          if (aiCreateCount >= MAX_AI_CREATES_PER_RESPONSE) {
            console.debug(JSON.stringify({ event: "ai:layout:cap", dropped: "drawScene", count: aiCreateCount }));
            return { created: 0, label, bounds: { x: 0, y: 0, width: w, height: h }, batchId: "", partIds: [] };
          }
          if (createBudget && globalMaxCreates !== undefined && createBudget.used >= globalMaxCreates) {
            console.debug(
              JSON.stringify({ event: "ai:layout:global-cap", dropped: "drawScene", globalUsed: createBudget.used }),
            );
            return { created: 0, label, bounds: { x: 0, y: 0, width: w, height: h }, batchId: "", partIds: [] };
          }
        }
        if (qaMode) {
          console.log(JSON.stringify({ event: "ai:create:qa-bypass", objType: "drawScene", count: aiCreateCount }));
        }

        // Flow-place the bounding box (parts go inside it via relative coordinates)
        const hintPos = x !== undefined && y !== undefined ? { x, y } : undefined;
        const pos = await flowPlace(w, h + 32, hintPos); // +32 for label below
        const bx = pos.x;
        const by = pos.y;

        const compositionBatchId = crypto.randomUUID();
        const clamp = (v: number) => Math.max(0, Math.min(1, v));

        const partIds: string[] = [];
        let failed = 0;

        for (const part of parts) {
          const rx = clamp(part.relX);
          const ry = clamp(part.relY);
          const rw = clamp(part.relW);
          const rh = clamp(part.relH ?? part.relW);

          const absW = rw * w;
          const absH = rh * h;
          const absX = bx + rx * w - absW / 2;
          const absY = by + ry * h - absH / 2;

          const shapeType = part.shape === "circle" ? "circle" : part.shape === "line" ? "line" : "rect";
          const props: BoardObjectProps =
            shapeType === "line"
              ? { stroke: part.stroke || part.fill || "#94a3b8" }
              : { fill: part.fill || "#3b82f6", stroke: part.stroke };

          // Parts bypass enforcedCreate: composition parts stay at relative positions,
          // OOB clamping applied manually. No per-part count cap.
          const obj = makeObject(shapeType, { x: absX, y: absY }, absW, absH, props, compositionBatchId);
          obj.x = Math.max(CANVAS_MIN_X, Math.min(obj.x, CANVAS_MAX_X - obj.width));
          obj.y = Math.max(CANVAS_MIN_Y, Math.min(obj.y, CANVAS_MAX_Y - obj.height));
          const result = await createAndMutate(stub, obj);
          if ("error" in result) {
            failed++;
          } else {
            partIds.push(result.created as string);
          }
        }

        // Text label below the composition
        const labelWidth = Math.max(40, label.length * 8 + 16);
        const labelObj = makeObject(
          "text",
          { x: bx + w / 2 - labelWidth / 2, y: by + h + 8 },
          labelWidth,
          24,
          { text: label, color: "#1a1a2e" },
          compositionBatchId,
        );
        labelObj.x = Math.max(CANVAS_MIN_X, Math.min(labelObj.x, CANVAS_MAX_X - labelObj.width));
        labelObj.y = Math.max(CANVAS_MIN_Y, Math.min(labelObj.y, CANVAS_MAX_Y - labelObj.height));
        const labelResult = await createAndMutate(stub, labelObj);
        if (!("error" in labelResult)) partIds.push(labelResult.created as string);

        // Track the full composition bounding box (not individual parts)
        const compositionBounds = { x: bx, y: by, width: w, height: h + 32 };
        aiCreatedBounds.push(compositionBounds);
        sharedBounds?.push(compositionBounds);
        aiCreateCount++;
        if (createBudget) createBudget.used++;

        return {
          created: partIds.length,
          label,
          bounds: { x: bx, y: by, width: w, height: h },
          batchId: compositionBatchId,
          partIds,
          ...(failed > 0 && { error: `${failed}/${parts.length} parts failed` }),
        };
      }),
    }),

    // 20. createEffect
    createEffect: tool({
      description:
        "Trigger a transient visual particle effect at a canvas position. " +
        "sparkle: glittery burst for magical moments. poof: smoke cloud for disappearances. " +
        "explosion: dramatic burst for impacts or revelations. highlight: glowing ring for emphasis. " +
        "The effect auto-removes after duration ms. Use for theatrical punctuation without cluttering the canvas.",
      inputSchema: z.object({
        type: z.enum(["sparkle", "poof", "explosion", "highlight"]).describe("Effect type"),
        x: z.number().describe("X position on the canvas (center of the effect)"),
        y: z.number().describe("Y position on the canvas (center of the effect)"),
        duration: z.number().default(2000).describe("Effect duration in ms (default: 2000)"),
      }),
      execute: instrumentExecute("createEffect", async ({ type, x, y, duration }) => {
        const effect: TransientEffect = { type, x, y, duration };
        const result = await stub.mutate({ type: "obj:transient", effect });
        if (!result.ok) return { error: result.error };
        console.debug(JSON.stringify({ event: "ai:effect", type, x, y, duration }));
        return { effect: type, x, y, duration };
      }),
    }),

    // 21. setMood
    setMood: tool({
      description:
        "Shift the scene's atmospheric mood for ambient lighting and visual tone. " +
        "Use when the emotional tone genuinely changes - a comedy scene turning noir, " +
        "tension building toward a climax, triumph after a breakthrough. " +
        "Use sparingly - mood shifts should feel organic, not every message.",
      inputSchema: z.object({
        mood: z
          .enum(["comedy", "noir", "horror", "romance", "tension", "triumph", "chaos", "neutral"])
          .describe(
            "Scene mood: comedy (warm bright), noir (cool dark), horror (eerie red), romance (soft pink), tension (amber), triumph (golden), chaos (strobing), neutral (default)",
          ),
        intensity: z
          .number()
          .min(0)
          .max(1)
          .default(0.3)
          .describe("Intensity 0-1 (default 0.3 = subtle). Use 0.7+ only for peak/climax moments."),
      }),
      execute: instrumentExecute("setMood", async ({ mood, intensity }) => {
        const result = await stub.mutate({ type: "mood", mood, intensity });
        if (!result.ok) return { error: result.error };
        console.debug(JSON.stringify({ event: "ai:mood", mood, intensity }));
        return { mood, intensity };
      }),
    }),

    // 22. askAudience
    askAudience: tool({
      description:
        "Pose a multiple-choice question to the audience (spectators watching the live board). " +
        "Spectators vote for 15 seconds, then the winning choice is fed back to you as context for your next response. " +
        "Use at pivotal scene moments to let the audience co-direct: 'Should the villain escape or surrender?' " +
        "Provide 2-4 short option labels. Rate-limited: 1 poll at a time, 30s cooldown between polls.",
      inputSchema: z.object({
        question: z.string().describe("The question to pose to the audience (e.g. 'What should happen next?')"),
        options: z
          .array(z.string().min(1).max(40))
          .min(2)
          .max(4)
          .describe("2-4 short option labels for the audience to choose from"),
      }),
      execute: instrumentExecute("askAudience", async ({ question, options }) => {
        const pollOptions: PollOption[] = options.map((label: string) => ({
          id: crypto.randomUUID().slice(0, 8),
          label: label.trim(),
        }));
        const result = await stub.createPoll(question, pollOptions);
        if (!result.ok) return { error: result.error };
        console.debug(JSON.stringify({ event: "ai:poll:start", question, optionCount: pollOptions.length }));
        return { pollStarted: true, question, options: pollOptions.map((o) => o.label) };
      }),
    }),

    // 21. play_sfx
    play_sfx: tool({
      description:
        "Play a sound effect on the canvas for dramatic emphasis. " +
        "rimshot: after a punchline. record-scratch: surprising reveal. thunder: incoming drama. " +
        "sad-trombone: failure or disappointment. applause: triumph or bow. doorbell: visitor arriving. " +
        "dramatic-sting: plot twist. crickets: awkward silence. Use sparingly - 1 per response max.",
      inputSchema: z.object({
        effect: z
          .enum([
            "rimshot",
            "record-scratch",
            "thunder",
            "sad-trombone",
            "applause",
            "doorbell",
            "dramatic-sting",
            "crickets",
          ])
          .describe("Sound effect ID"),
        x: z.number().optional().describe("X position for the visual burst (default: canvas center 600)"),
        y: z.number().optional().describe("Y position for the visual burst (default: canvas center 420)"),
      }),
      execute: instrumentExecute("play_sfx", async ({ effect, x, y }) => {
        const result = await stub.mutate({ type: "sfx", effect, x: x ?? 600, y: y ?? 420 });
        if (!result.ok) return { error: result.error };
        console.debug(JSON.stringify({ event: "ai:sfx", effect, x: x ?? 600, y: y ?? 420 }));
        return { played: effect };
      }),
    }),
  };

  // Registry of execute functions from tools 1-13, keyed by name.
  // Excludes batchExecute itself to prevent recursive batching.
  // Double-cast through unknown: each tool's execute has Zod-narrowed args, but at runtime
  // all accept Record<string,unknown> (instrumentExecute guards malformed inputs).
  type AnyExec = (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
  const toolRegistry: Record<string, AnyExec> = Object.fromEntries(
    Object.entries(baseTools).map(([name, t]) => [name, (t as unknown as { execute: AnyExec }).execute]),
  );

  return {
    ...baseTools,

    // KEY-DECISION 2026-02-20: @cloudflare/codemode (LLM code-execution for tool orchestration)
    // evaluated and rejected. Our budget models (GLM, GPT-4o Mini) can't reliably generate
    // TypeScript, batchExecute + choreograph cover multi-step needs declaratively, and CodeMode
    // would regress per-tool Langfuse observability. Revisit if: tool count >40 with cross-deps,
    // default model upgrades to frontier tier, AND Worker Loader API exits beta.
    // Full analysis: docs/cloudflare-codemod-exploration.md

    // 12. batchExecute
    batchExecute: tool({
      description:
        "Execute multiple canvas operations in a single call. Use when creating related objects " +
        "together (e.g. a frame with stickies inside it, or a row of characters). Operations run " +
        "in order; failures are recorded but do not stop the batch. Max 10 operations per call. " +
        "Prefer individual tools when you need to act on results between steps (e.g. getBoardState " +
        "then decide what to create) - batch args are pre-computed and cannot chain across ops.",
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              tool: z
                .enum([
                  "createStickyNote",
                  "createPerson",
                  "createShape",
                  "createFrame",
                  "createConnector",
                  "moveObject",
                  "resizeObject",
                  "updateText",
                  "changeColor",
                  "deleteObject",
                  "generateImage",
                  "createText",
                  "choreograph",
                  "spotlight",
                  "blackout",
                  "drawScene",
                  "createEffect",
                  "setMood",
                ])
                .describe("Tool name to execute"),
              args: z.record(z.string(), z.unknown()).describe("Arguments for the tool (same as calling it directly)"),
            }),
          )
          .max(10)
          .describe("Ordered list of operations to execute sequentially"),
      }),
      execute: instrumentExecute("batchExecute", async ({ operations }) => {
        const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

        const results: unknown[] = [];
        let failed = 0;
        const toolNames = operations.map((op) => op.tool);
        console.debug(JSON.stringify({ event: "batch:start", count: operations.length, tools: toolNames }));

        for (const op of operations) {
          const executeFn = toolRegistry[op.tool];
          if (!executeFn) {
            // Programming error: Zod enum should prevent unknown tool names - log for diagnosis
            console.error(JSON.stringify({ event: "batch:unknown-tool", tool: op.tool }));
            results.push({ error: `Unknown tool: ${op.tool}` });
            failed++;
            continue;
          }
          try {
            const result = await executeFn(op.args);
            results.push(result);
            if (isPlainObject(result) && "error" in result) failed++;
          } catch (err) {
            // Unexpected throw not caught by instrumentExecute (which rethrows) - log for diagnosis
            console.error(JSON.stringify({ event: "batch:op:error", tool: op.tool, error: errMsg(err) }));
            results.push({ error: `${op.tool} failed: ${errMsg(err)}` });
            failed++;
          }
        }

        if (failed > 0) {
          console.error(
            JSON.stringify({
              event: "batch:partial-failure",
              completed: operations.length - failed,
              failed,
              tools: toolNames,
            }),
          );
        }

        const completed = operations.length - failed;
        console.log(
          JSON.stringify({
            event: "ai:batch:done",
            total: operations.length,
            succeeded: results.filter((r) => !(isPlainObject(r) && "error" in r)).length,
          }),
        );
        return {
          completed,
          failed,
          results,
          // Surface partial failures to instrumentExecute's ok check (which looks for "error" key)
          ...(failed > 0 && { error: `${failed}/${operations.length} operations failed` }),
        };
      }),
    }),
  };
}

/** Tool name = each key in the registry returned by createSDKTools */
export type ToolName = keyof ReturnType<typeof createSDKTools>;
