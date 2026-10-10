import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a failed wake stays visible after the status refresh", async ({ page }, testInfo) => {
  await signup(page, `wake-failed-${Date.now()}@rakazo.test`, "password12", "Wake Failed");
  await completeOnboarding(page);

  let boots = 0;
  let releaseScreen: () => void = () => undefined;
  const screenAfterBoot = new Promise<void>((resolve) => {
    releaseScreen = resolve;
  });
  await page.route("**/rpc/computer/boot", async (route) => {
    boots += 1;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: "Team desktop did not become ready.",
        },
      }),
    });
    releaseScreen();
  });
  await page.route("**/rpc/computer/screenUrl", async (route) => {
    if (boots === 0) await screenAfterBoot;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: null } }),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { computer?: Record<string, unknown> } };
    const computer = body.json?.computer;
    if (computer) {
      computer.state = boots > 0 ? "suspended" : "stopped";
      computer.screenAvailable = false;
      computer.busyBotName = null;
    }
    await route.fulfill({ response, json: body });
  });

  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  const retry = preview.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(preview.getByText("Team desktop did not become ready.")).toBeVisible();
  await expect(preview.getByText("Computer is asleep. Open it to wake.")).toHaveCount(0);

  await page.getByTitle("Agent computer").click();
  await page.getByTitle("Agent computer").click();
  await expect(retry).toBeVisible();
  await expect(preview.getByText("Team desktop did not become ready.")).toBeVisible();
  await expect(preview.getByText("Computer is asleep. Open it to wake.")).toHaveCount(0);
  expect(boots).toBe(1);
  await captureScreenshot(page, testInfo, "computer-wake-failed");
});
