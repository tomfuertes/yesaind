# Open Tasks

## BLOCKING: Push + Deploy (do this first)

### 1. Push all commits to deploy
Git auth expired in devcontainer. From laptop:
```bash
cd ~/sandbox/git-repos/yesaind
git push
npm run migrate:remote
```
**Commits include:**
- feat(tools): add optional x,y coordinate hints to create tools
- fix(show-agent): correct Haiku model ID (20250414 -> 20251001)
- fix(show-agent): idFromString -> idFromName (DO ID format bug)
- fix(prompts): stickies sparingly, text for action words
- fix(templates): replace stickies-in-frames with person+text objects
- docs: deliverables link + blog post in README
- docs: social post link in deliverables

**Uncommitted (need to commit first):**
- `src/server/show-agent.ts` - idFromName fix
- `src/server/prompts/system.ts` - sticky note guidance
- `src/server/ai-tools-sdk.ts` - sticky tool description
- `src/shared/board-templates.ts` - person+text templates
- `src/server/prompts/stage-manager.ts` - x,y hint allowance
- `README.md` - deliverables + blog post link
- `deliverables/README.md` - blog post + social post links

## After Deploy

### 2. UAT AI Show feature on prod
Test full AI Show flow on yesaind.com:
1. Login, navigate to board list
2. Click "Watch a Show", select a premise
3. Verify POST /api/shows succeeds -> redirects to #watch/<boardId>
4. Watch spectator view - objects should appear as ShowAgent fires turns
5. Verify 12 turns complete with curtain call + applause sfx
6. Test replay via #replay/<boardId>
7. Test SM: prefix (type "sm: rearrange" - stage manager fires silently)

### 3. Create OG image for social share meta tags
- Screenshot a live scene (1200x630)
- Upload to R2 or public URL
- Add og:image + twitter:image to index.html

## New items from this session

### 4. ShowAgent observability gap
ShowAgent calls generateText directly without tracing middleware. Show turns don't appear in Langfuse. Add wrapLanguageModel(model, tracingMiddleware(...)) pattern from ChatAgent.

### 5. Background image generation may be broken
`_generateBackground` is skipped when troupeConfig is present (line 831 chat-agent.ts). Since OnboardModal always sets troupeConfig, backgrounds rely on stage manager calling generateImage. If Workers AI auth fails, backdrop silently doesn't appear. Verify on prod after deploy - if no backdrops, either:
- Add generateBackground call inside _runStageManager as fallback
- Or remove the troupeConfig guard on _generateBackground

### 6. Demo video (3-5 min)
Last deliverable still TBD. Record: real-time collaboration, AI commands, architecture explanation.
