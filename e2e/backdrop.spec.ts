import { test, expect } from "@playwright/test";
import {
  signUp,
  createBoard,
  navigateToBoard,
  waitForObjectCount,
  getObjectCount,
} from "./helpers";

const baseURL = process.env.BACKDROP_TEST_URL || "https://yesaind.com";

test.describe("Backdrop image persistence", () => {
  test.setTimeout(30_000);

  test("image object with isBackground=true persists correctly through WS -> DO -> API", async ({ browser }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // Setup
    const { username } = await signUp(context);
    const boardId = await createBoard(context, `Backdrop Test - ${Date.now()}`);
    await navigateToBoard(page, boardId);

    // Manually create a backdrop image via WebSocket
    // This simulates what generateImage tool does when w>=800 && h>=600
    await page.evaluate(
      ({ boardId }) => {
        return new Promise<void>((resolve, reject) => {
          const protocol = location.protocol === "https:" ? "wss:" : "ws:";
          const ws = new WebSocket(`${protocol}//${location.host}/ws/board/${boardId}`);
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: "obj:create",
                obj: {
                  id: `backdrop-${Date.now()}`,
                  type: "image",
                  x: 50,  // CANVAS_MIN_X
                  y: 60,  // CANVAS_MIN_Y
                  width: 1100,
                  height: 720,
                  rotation: 0,
                  props: { src: "test.jpg", prompt: "test backdrop" },
                  createdBy: "uat-test",
                  updatedAt: Date.now(),
                  isBackground: true,
                },
              }),
            );
            setTimeout(() => {
              ws.close();
              resolve();
            }, 500);
          };
          ws.onerror = () => reject(new Error("WebSocket connection failed"));
          setTimeout(() => reject(new Error("WebSocket timeout")), 10_000);
        });
      },
      { boardId },
    );

    // Wait for object to appear
    await waitForObjectCount(page, 1);
    const count = await getObjectCount(page);
    expect(count).toBe(1);

    // Verify via API - this is the critical verification
    const objectsRes = await context.request.get(`/api/boards/${boardId}/objects`);
    expect(objectsRes.ok()).toBeTruthy();
    const responseBody = await objectsRes.json();
    const { objects } = responseBody;
    
    const backdrop = objects.find((o: any) => o.type === "image");
    expect(backdrop).toBeDefined();
    expect(backdrop.isBackground).toBe(true);
    expect(backdrop.width).toBeGreaterThanOrEqual(800);
    expect(backdrop.height).toBeGreaterThanOrEqual(600);
    expect(backdrop.x).toBe(50);
    expect(backdrop.y).toBe(60);

    console.log("✓ Backdrop object verified:", {
      id: backdrop.id,
      width: backdrop.width,
      height: backdrop.height,
      x: backdrop.x,
      y: backdrop.y,
      isBackground: backdrop.isBackground,
    });

    await context.close();
  });
});

