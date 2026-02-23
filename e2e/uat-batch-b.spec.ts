import { test, expect } from "@playwright/test";

test.describe("UAT Batch B - Sonnet Model + Crisis Escalation", () => {
  const BASE_URL = "https://yesaind.com";
  test.setTimeout(90000); // 90 second timeout per test

  // Board 1: Superhero team stops alien invasion
  test("Board 1 - Superhero + Crisis Escalation", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Sign up
      const username1 = `uat-b-${Date.now()}-1`;
      await context.request.post(`${BASE_URL}/auth/signup`, {
        data: { username: username1, password: "password123" },
      });

      // Create board
      const boardRes = await context.request.post(`${BASE_URL}/api/boards`, {
        data: { name: "superhero team stops alien invasion" },
      });
      const board1 = await boardRes.json();
      const boardId1 = board1.id;
      console.log("Board 1 ID:", boardId1);

      // Navigate to board
      await page.goto(`${BASE_URL}/#board/${boardId1}`);
      await page.waitForTimeout(2000);

      // Set initiator key and reload
      await page.evaluate((boardId) => {
        sessionStorage.setItem(`yesaind:initiator:${boardId}`, "1");
      }, boardId1);
      await page.reload();
      await page.waitForTimeout(3000);

      // Skip through onboard modal - just close it by clicking outside or finding skip button
      // Try clicking "Skip" button to bypass modal
      const skipButton = page.locator("button:has-text('Skip')").first();
      if (await skipButton.isVisible({ timeout: 5000 })) {
        await skipButton.click();
        await page.waitForTimeout(2000);
      }

      console.log("Onboarding skipped");

      // Get initial object count
      const objsBefore = await context.request.get(`${BASE_URL}/api/boards/${boardId1}/objects`);
      const dataBefore = await objsBefore.json();
      console.log("Objects before:", dataBefore.objects.length);

      await page.screenshot({ path: "screenshots/uat-b-board1-ready.png" });

    } catch (e) {
      console.error("Test error:", e);
      throw e;
    } finally {
      try {
        await context.close();
      } catch (e) {
        console.log("Error closing context (expected)");
      }
    }
  });

  // Board 2: Medieval knights discover time travel
  test("Board 2 - Medieval + Plot Twist Crisis", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Sign up
      const username2 = `uat-b-${Date.now()}-2`;
      await context.request.post(`${BASE_URL}/auth/signup`, {
        data: { username: username2, password: "password123" },
      });

      // Create board
      const boardRes = await context.request.post(`${BASE_URL}/api/boards`, {
        data: { name: "medieval knights discover time travel" },
      });
      const board2 = await boardRes.json();
      const boardId2 = board2.id;
      console.log("Board 2 ID:", boardId2);

      // Navigate to board
      await page.goto(`${BASE_URL}/#board/${boardId2}`);
      await page.waitForTimeout(2000);

      // Set initiator key and reload
      await page.evaluate((boardId) => {
        sessionStorage.setItem(`yesaind:initiator:${boardId}`, "1");
      }, boardId2);
      await page.reload();
      await page.waitForTimeout(3000);

      // Skip onboard modal
      const skipButton = page.locator("button:has-text('Skip')").first();
      if (await skipButton.isVisible({ timeout: 5000 })) {
        await skipButton.click();
        await page.waitForTimeout(2000);
      }

      console.log("Onboarding skipped");

      // Get initial object count
      const objsBefore = await context.request.get(`${BASE_URL}/api/boards/${boardId2}/objects`);
      const dataBefore = await objsBefore.json();
      console.log("Objects before:", dataBefore.objects.length);

      await page.screenshot({ path: "screenshots/uat-b-board2-ready.png" });

    } catch (e) {
      console.error("Test error:", e);
      throw e;
    } finally {
      try {
        await context.close();
      } catch (e) {
        console.log("Error closing context (expected)");
      }
    }
  });
});
