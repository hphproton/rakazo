import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows a synced Hub member in the Hub roster section", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hub-roster-${stamp}@rakazo.test`, "password12", "Hub Roster");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const synced = await rpc<{
    sectionName: string;
    directory: { hubMembers: Array<{ botId: string; name: string }> };
  }>(page, "hub/syncMembers", {
    members: [{ hubAgentId: "hub-atlas", name: "Atlas", title: "Deploy" }],
  });
  expect(synced.sectionName).toBe("Hub");
  const botId = synced.directory.hubMembers[0]?.botId;
  expect(botId).toBeTruthy();

  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByRole("button", { name: "Collapse Hub" })).toBeVisible();
  const row = sidebar.locator(`[data-roster-bot-id="${botId}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator("[data-roster-bot-name]")).toHaveText("Atlas");
  await expect(sidebar.getByText("Chief").first()).toBeVisible();

  await captureScreenshot(page, testInfo, "hub-roster-section");
});
