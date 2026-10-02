import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("opens one Hub topic for two members and both replies", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 980, height: 720 });
  await page.goto("/e2e/fixtures/hub-topic.html");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByTestId("peer-receipt-chip")).toHaveCount(2);
  await expect(
    transcript.getByRole("button", { name: "To Hub · Box Principal, OSS Local Lab", exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByRole("button", {
      name: "Message from Hub · Box Principal, OSS Local Lab",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    transcript.getByRole("button", { name: "To Hub · Box Principal", exact: true }),
  ).toHaveCount(0);
  await expect(
    transcript.getByRole("button", { name: "To Hub · OSS Local Lab", exact: true }),
  ).toHaveCount(0);
  await expect(transcript.getByText("Principal ready.")).toHaveCount(0);
  await expect(transcript.getByText("Lab ready.")).toHaveCount(0);

  const view = page.getByTestId("peer-conversation-view");
  await expect(
    view.getByRole("heading", { name: "Chief · Hub · Box Principal, OSS Local Lab" }),
  ).toBeVisible();
  const turns = view.getByTestId("peer-conversation-turn");
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(0)).toHaveAttribute("data-direction", "sent");
  await expect(turns.nth(0)).toContainText("Chief · Hub · Box Principal");
  await expect(turns.nth(0)).toContainText("Check the deploy.");
  await expect(turns.nth(1)).toContainText("Chief · Hub · OSS Local Lab");
  await expect(turns.nth(1)).toContainText("Check the lab.");
  await expect(turns.nth(2)).toHaveAttribute("data-direction", "received");
  await expect(turns.nth(2)).toContainText("Hub · Box Principal");
  await expect(turns.nth(2)).toContainText("Principal ready.");
  await expect(turns.nth(3)).toContainText("Hub · OSS Local Lab");
  await expect(turns.nth(3)).toContainText("Lab ready.");
  await expect(view.getByText("Asked both.")).toHaveCount(0);
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("textbox")).toHaveCount(0);

  await captureScreenshot(page, testInfo, "hub-multi-party-topic");
});
