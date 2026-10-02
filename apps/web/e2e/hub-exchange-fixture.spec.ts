import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("renders Hub inbound and outbound as one chip family and one transcript", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 980, height: 520 });
  await page.goto("/e2e/fixtures/hub-exchange.html");
  const transcript = page.getByTestId("transcript");
  const inbound = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Message from Hub · Box Principal" });
  const outbound = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "To Hub · Box Principal" });
  await expect(inbound).toBeVisible();
  await expect(outbound).toBeVisible();
  const transcriptBox = await transcript.boundingBox();
  const outboundBox = await outbound.boundingBox();
  expect(transcriptBox).not.toBeNull();
  expect(outboundBox).not.toBeNull();
  expect(outboundBox!.x - transcriptBox!.x).toBeLessThanOrEqual(32);
  expect(outboundBox!.width).toBeLessThan(transcriptBox!.width * 0.75);
  await expect(transcript.getByText("NATIVE_HUB_SEND_SMOKE")).toHaveCount(0);
  await expect(transcript.getByText("Ship the notes.")).toHaveCount(0);
  await expect(transcript.getByText("Queued for Box Principal.")).toBeVisible();

  const view = page.getByTestId("peer-conversation-view");
  await expect(view.getByRole("heading", { name: "Chief · Hub · Box Principal" })).toBeVisible();
  await expect(
    view.locator('[data-direction="received"]').getByText("Ship the notes."),
  ).toBeVisible();
  await expect(
    view.locator('[data-direction="sent"]').getByText("NATIVE_HUB_SEND_SMOKE"),
  ).toBeVisible();
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("textbox")).toHaveCount(0);

  await captureScreenshot(page, testInfo, "hub-exchange-parity");
});
