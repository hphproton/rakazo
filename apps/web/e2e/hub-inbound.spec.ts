import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows a Hub inbound as a peer marker, not a user bubble", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const token = `hub-deploy-${stamp}`;
  await signup(page, `hub-in-${stamp}@rakazo.test`, "password12", "Hub In");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botId = activeBotId(page);
  await rpc(page, "threads/receiveHub", {
    botId,
    hubAgentId: "hub-atlas",
    hubAgentName: "Atlas",
    text: token,
    clientNonce: `hub-${stamp}`,
  });
  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);

  const transcript = page.getByTestId("transcript");
  const chip = transcript.getByTestId("peer-receipt-chip").filter({ hasText: "Hub · Atlas" });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAccessibleName("Message from Hub · Atlas");
  await expect(chip).not.toContainText(token);
  await expect(
    transcript.getByTestId("message-user-bubble").filter({ hasText: token }),
  ).toHaveCount(0);

  await captureScreenshot(page, testInfo, "hub-inbound-chip");

  await chip.click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Hub · Atlas/ })).toBeVisible();
  await expect(view.getByText(token).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "hub-inbound-peer-view");
});
