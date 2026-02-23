/**
 * Prompt module barrel - re-exports all prompt text and builder functions.
 *
 * Structure:
 *   system.ts       - Core system prompt, scene setup, momentum (the tuning surface)
 *   intents.ts      - Intent chip prompts (per-chip injections)
 *   personas.ts     - Persona identity and relationship tracking
 *   game-modes.ts   - Game mode rules (yesand, harold)
 *   dramatic-arc.ts - Scene phases, lifecycle, turn budget
 *   stage-manager.ts - Silent pre-flight stage setup
 *   reactions.ts    - Event-driven reactive prompts (canvas, heckle, wave, sfx, etc.)
 *   critic.ts       - Post-scene AI critic review
 */

/** Bump when prompt content changes - logged with every AI request for correlation */
export const PROMPT_VERSION = "v29";

// Core prompt text
export { SYSTEM_PROMPT, SCENE_SETUP_PROMPT, MOMENTUM_PROMPT } from "./system";

// Intent chips
export { INTENT_PROMPTS } from "./intents";

// Personas
export { MAX_AUTONOMOUS_EXCHANGES, buildRelationshipBlock, buildPersonaSystemPrompt } from "./personas";

// Game modes
export type { GameModeState } from "./game-modes";
export { buildGameModePromptBlock, DIRECTOR_PROMPTS_HAROLD, DIRECTOR_PROMPTS_YESAND } from "./game-modes";

// Dramatic arc
export type { ScenePhase, BudgetPhase } from "./dramatic-arc";
export {
  computeScenePhase,
  DIRECTOR_PROMPTS,
  computeBudgetPhase,
  BUDGET_PROMPTS,
  computeLifecyclePhase,
  buildLifecycleBlock,
} from "./dramatic-arc";

// Stage manager
export { STAGE_MANAGER_PROMPT, buildStageManagerPrompt } from "./stage-manager";

// Reactions
export {
  PLOT_TWISTS,
  buildPlotTwistPrompt,
  buildCanvasReactionPrompt,
  buildTagOutPrompt,
  buildHecklePrompt,
  buildWavePrompt,
  buildSfxReactionPrompt,
  buildDirectorNotePrompt,
  buildPollResultPrompt,
  buildQACommandPrompt,
} from "./reactions";

// Critic
export { CRITIC_PROMPT } from "./critic";

// Quality signal
export type { QualitySignalContext, QualitySignalScores } from "./quality-signal";
export { buildQualitySignalPrompt } from "./quality-signal";
