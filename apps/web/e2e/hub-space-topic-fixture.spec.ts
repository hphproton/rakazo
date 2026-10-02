import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("joins Chief and Deputy in the existing topic view when they share a key", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 980, height: 900 });
  await page.goto("/e2e/fixtures/hub-space-topic.html");

  for (const testId of ["chief-thread", "deputy-thread"]) {
    const thread = page.getByTestId(testId);
    await expect(thread.getByTestId("peer-receipt-chip")).toHaveCount(2);
    await expect(
      thread.getByRole("button", { name: "To Hub · Box Principal, OSS Local Lab", exact: true }),
    ).toBeVisible();
    await expect(
      thread.getByRole("button", {
        name: "Message from Hub · Box Principal, OSS Local Lab",
        exact: true,
      }),
    ).toBeVisible();
  }

  const view = page.getByTestId("peer-conversation-view");
  await expect(
    view.getByRole("heading", {
      name: "Chief, Deputy · Hub · Box Principal, OSS Local Lab",
    }),
  ).toBeVisible();
  const turns = view.getByTestId("peer-conversation-turn");
  await expect(turns).toHaveCount(8);
  await expect(turns.nth(0)).toContainText("Chief · Hub · Box Principal");
  await expect(turns.nth(0)).toContainText("Check the deploy.");
  await expect(turns.nth(1)).toContainText("Deputy · Hub · Box Principal");
  await expect(turns.nth(1)).toContainText("Deputy deploy.");
  await expect(turns.nth(4)).toContainText("Hub · Box Principal");
  await expect(turns.nth(4)).toContainText("Principal ready.");
  await expect(turns.nth(5)).toContainText("Principal to Deputy.");
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("textbox")).toHaveCount(0);

  await captureScreenshot(page, testInfo, "hub-space-topic");
});
