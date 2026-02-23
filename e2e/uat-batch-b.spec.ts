import { test, expect } from "@playwright/test";
import { signUp, createBoard, navigateToBoard } from "./helpers";

const baseURL = process.env.BACKDROP_TEST_URL || "https://yesaind.com";

test.describe("UAT Batch B - Sonnet Model + Crisis Escalation", () => {
  test.setTimeout(120_000);

  async function closeOnboardModal(page: any) {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      const raiseCurtains = page.locator("button:has-text('Raise curtains')").first();
      if (await raiseCurtains.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("Found 'Raise curtains', clicking...");
        await raiseCurtains.click();
        await page.waitForTimeout(2000);
        return;
      }

      const skipBtn = page.locator("button:has-text('Skip')").first();
      if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("Found 'Skip', clicking...");
        await skipBtn.click();
        await page.waitForTimeout(1500);
        attempts++;
        continue;
      }

      const nextBtn = page.locator("button:has-text('Next →')").first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("Found 'Next', clicking...");
        await nextBtn.click();
        await page.waitForTimeout(1500);
        attempts++;
        continue;
      }

      const getStarted = page.locator("button:has-text('Get Started')").first();
      if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("Found 'Get Started', clicking...");
        await getStarted.click();
        await page.waitForTimeout(1500);
        attempts++;
        continue;
      }

      console.log("No modal buttons found, assuming closed");
      break;
    }
  }

  test("Board 1 - Superhero + Crisis Escalation", async ({ browser }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    try {
      console.log("=== Board 1 Test Start ===");

      // Sign up
      const { username } = await signUp(context);
      console.log("Signed up:", username);

      // Create board
      const boardId = await createBoard(context, "uat-b-superhero-invasion");
      console.log("Board ID:", boardId);

      // Navigate
      await navigateToBoard(page, boardId);
      console.log("Navigated to board");

      // Set initiator
      await page.evaluate((bid) => {
        sessionStorage.setItem(`yesaind:initiator:${bid}`, "1");
      }, boardId);

      // Reload
      await page.reload();
      await page.waitForTimeout(3000);

      // Close modal
      await closeOnboardModal(page);
      await page.waitForTimeout(2000);

      console.log("Onboarding modal closed");

      // Open chat panel by clicking the speech bubble icon in toolbar
      const chatButton = page.locator("button[title*='Assistant'], svg[class*='chat'] ~ button, button:has-text('AI')").first();
      const chatIcon = page.locator("button").filter({ has: page.locator("svg") }).nth(8); // Approximate index based on toolbar order
      
      // Try clicking via keyboard shortcut first (/)
      await page.keyboard.press("Slash");
      await page.waitForTimeout(1500);

      // Screenshot ready board
      await page.screenshot({ path: "screenshots/uat-b-board1-ready.png" });

      // Get baseline
      const beforeRes = await context.request.get(`/api/boards/${boardId}/objects`);
      expect(beforeRes.ok()).toBeTruthy();
      const beforeData = await beforeRes.json();
      const baselineCount = beforeData.objects.length;
      console.log("Objects at baseline:", baselineCount);

      // Find chat input (now should be visible on right panel)
      const chatInput = page.locator("textarea").first();
      let messagesAttempted = 0;

      if (await chatInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("Found chat textarea, sending messages...");

        // Message 1
        await chatInput.click();
        await chatInput.fill("Tell me about a superhero team fighting an alien invasion");
        await page.keyboard.press("Enter");
        messagesAttempted++;
        console.log("Message 1 sent");
        await page.waitForTimeout(7000);

        // Message 2
        await chatInput.fill("What weapons do they use?");
        await page.keyboard.press("Enter");
        messagesAttempted++;
        console.log("Message 2 sent");
        await page.waitForTimeout(7000);

        // Message 3
        await chatInput.fill("Will they succeed?");
        await page.keyboard.press("Enter");
        messagesAttempted++;
        console.log("Message 3 sent");
        await page.waitForTimeout(7000);
      } else {
        console.log("Chat input not visible");
      }

      // Get count before crisis
      const midRes = await context.request.get(`/api/boards/${boardId}/objects`);
      expect(midRes.ok()).toBeTruthy();
      const midData = await midRes.json();
      const beforeCrisisCount = midData.objects.length;
      console.log("Objects before crisis:", beforeCrisisCount);

      await page.screenshot({ path: "screenshots/uat-b-board1-before-crisis.png" });

      // Click "escalate!" chip
      const escalateChip = page.locator("button:has-text('escalate!')").first();
      if (await escalateChip.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("Found 'escalate!' chip, clicking...");
        await escalateChip.click();
        await page.waitForTimeout(8000);
      } else {
        console.log("'escalate!' chip not visible");
      }

      // Get count after crisis
      const afterRes = await context.request.get(`/api/boards/${boardId}/objects`);
      expect(afterRes.ok()).toBeTruthy();
      const afterData = await afterRes.json();
      const afterCrisisCount = afterData.objects.length;
      console.log("Objects after crisis:", afterCrisisCount);

      // Count by type
      const objectTypes = afterData.objects.reduce((acc: any, o: any) => {
        acc[o.type] = (acc[o.type] || 0) + 1;
        return acc;
      }, {});
      console.log("Objects by type:", objectTypes);

      const hasBackdrop = afterData.objects.some((o: any) => o.isBackground);
      console.log("Backdrop present:", hasBackdrop);

      await page.screenshot({ path: "screenshots/uat-b-board1-after-crisis.png" });

      console.log("=== Board 1 Summary ===");
      console.log({
        boardId,
        baseline: baselineCount,
        beforeCrisis: beforeCrisisCount,
        afterCrisis: afterCrisisCount,
        backdrop: hasBackdrop,
        messagesAttempted,
        crisisGrowth: afterCrisisCount - beforeCrisisCount,
      });

    } finally {
      try {
        await context.close();
      } catch (e) {
        // Ignore
      }
    }
  });

  test("Board 2 - Medieval + Plot Twist Crisis", async ({ browser }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    try {
      console.log("=== Board 2 Test Start ===");

      // Sign up
      const { username } = await signUp(context);
      console.log("Signed up:", username);

      // Create board
      const boardId = await createBoard(context, "uat-b-medieval-timetravel");
      console.log("Board ID:", boardId);

      // Navigate
      await navigateToBoard(page, boardId);
      console.log("Navigated to board");

      // Set initiator
      await page.evaluate((bid) => {
        sessionStorage.setItem(`yesaind:initiator:${bid}`, "1");
      }, boardId);

      // Reload
      await page.reload();
      await page.waitForTimeout(3000);

      // Close modal
      await closeOnboardModal(page);
      await page.waitForTimeout(2000);

      // Open chat panel
      await page.keyboard.press("Slash");
      await page.waitForTimeout(1500);

      await page.screenshot({ path: "screenshots/uat-b-board2-ready.png" });

      // Get baseline
      const beforeRes = await context.request.get(`/api/boards/${boardId}/objects`);
      expect(beforeRes.ok()).toBeTruthy();
      const beforeData = await beforeRes.json();
      const baselineCount = beforeData.objects.length;
      console.log("Objects at baseline:", baselineCount);

      // Find chat input
      const chatInput = page.locator("textarea").first();
      let messagesAttempted = 0;

      if (await chatInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("Found chat textarea, sending messages...");

        await chatInput.click();
        await chatInput.fill("Medieval knights discover a shimmering portal");
        await page.keyboard.press("Enter");
        messagesAttempted++;
        console.log("Message 1 sent");
        await page.waitForTimeout(7000);

        await chatInput.fill("What time period does it lead to?");
        await page.keyboard.press("Enter");
        messagesAttempted++;
        console.log("Message 2 sent");
        await page.waitForTimeout(7000);

        await chatInput.fill("How do they get back?");
        await page.keyboard.press("Enter");
        messagesAttempted++;
        console.log("Message 3 sent");
        await page.waitForTimeout(7000);
      } else {
        console.log("Chat input not visible");
      }

      // Get count before plot twist
      const midRes = await context.request.get(`/api/boards/${boardId}/objects`);
      expect(midRes.ok()).toBeTruthy();
      const midData = await midRes.json();
      const beforeCrisisCount = midData.objects.length;
      console.log("Objects before plot twist:", beforeCrisisCount);

      await page.screenshot({ path: "screenshots/uat-b-board2-before-crisis.png" });

      // Click "plot twist!" chip
      const twistChip = page.locator("button:has-text('plot twist!')").first();
      if (await twistChip.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("Found 'plot twist!' chip, clicking...");
        await twistChip.click();
        await page.waitForTimeout(8000);
      } else {
        console.log("'plot twist!' chip not visible");
      }

      // Get count after
      const afterRes = await context.request.get(`/api/boards/${boardId}/objects`);
      expect(afterRes.ok()).toBeTruthy();
      const afterData = await afterRes.json();
      const afterCrisisCount = afterData.objects.length;
      console.log("Objects after plot twist:", afterCrisisCount);

      // Count by type
      const objectTypes = afterData.objects.reduce((acc: any, o: any) => {
        acc[o.type] = (acc[o.type] || 0) + 1;
        return acc;
      }, {});
      console.log("Objects by type:", objectTypes);

      const hasBackdrop = afterData.objects.some((o: any) => o.isBackground);
      console.log("Backdrop present:", hasBackdrop);

      await page.screenshot({ path: "screenshots/uat-b-board2-after-crisis.png" });

      console.log("=== Board 2 Summary ===");
      console.log({
        boardId,
        baseline: baselineCount,
        beforeCrisis: beforeCrisisCount,
        afterCrisis: afterCrisisCount,
        backdrop: hasBackdrop,
        messagesAttempted,
        crisisGrowth: afterCrisisCount - beforeCrisisCount,
      });

    } finally {
      try {
        await context.close();
      } catch (e) {
        // Ignore
      }
    }
  });
});
