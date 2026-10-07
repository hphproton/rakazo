import { expect, type Page, type Route, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows Hub inbound and outbound as one chip family in one conversation", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const inboundToken = `hub-deploy-${stamp}`;
  const outboundToken = `hub-out-${stamp}`;
  await signup(page, `hub-in-${stamp}@rakazo.test`, "password12", "Hub In");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botId = activeBotId(page);
  await rpc(page, "threads/receiveHub", {
    botId,
    hubAgentId: "hub-atlas",
    hubAgentName: "Atlas",
    text: inboundToken,
    clientNonce: `hub-${stamp}`,
  });
  await installHubOutboundEcho(page, outboundToken);
  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);

  const transcript = page.getByTestId("transcript");
  const inbound = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Message from Hub · Atlas" });
  const outbound = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "To Hub · Atlas" });
  await expect(inbound).toBeVisible({ timeout: 30_000 });
  await expect(outbound).toBeVisible();
  await expect(inbound).toHaveAccessibleName("Message from Hub · Atlas");
  await expect(outbound).toHaveAccessibleName("To Hub · Atlas");
  await expect(inbound).not.toContainText(inboundToken);
  await expect(outbound).not.toContainText(outboundToken);
  await expect(transcript.getByText(outboundToken)).toHaveCount(0);
  await expect(transcript.getByTestId("hub-outbound")).toHaveCount(0);
  await expect(transcript.getByTestId("hub-outbound-text")).toHaveCount(0);
  await expect(
    transcript.getByTestId("message-user-bubble").filter({ hasText: inboundToken }),
  ).toHaveCount(0);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByText("Atlas")).toHaveCount(0);

  const transcriptBox = await transcript.boundingBox();
  const outboundBox = await outbound.boundingBox();
  expect(transcriptBox).not.toBeNull();
  expect(outboundBox).not.toBeNull();
  expect(outboundBox!.x - transcriptBox!.x).toBeLessThanOrEqual(32);
  expect(outboundBox!.width).toBeLessThan(transcriptBox!.width * 0.75);

  await captureScreenshot(page, testInfo, "hub-exchange-chips");

  await outbound.click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Hub · Atlas/ })).toBeVisible();
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("textbox")).toHaveCount(0);
  const sent = view.locator('[data-direction="sent"]');
  const received = view.locator('[data-direction="received"]');
  await expect(sent.getByText(outboundToken)).toBeVisible();
  await expect(received.getByText(inboundToken)).toBeVisible();
  await captureScreenshot(page, testInfo, "hub-exchange-conversation");

  await view.getByRole("button", { name: "Close" }).click();
  await expect(view).toHaveCount(0);
  await inbound.click();
  await expect(page.getByTestId("peer-conversation-view").getByText(outboundToken)).toBeVisible();
  await expect(page.getByTestId("peer-conversation-view").getByText(inboundToken)).toBeVisible();
});

type HubThreadPage = {
  threadId?: string;
  botId?: string;
  messages?: Array<Record<string, unknown>>;
  thread?: HubThreadPage;
};

async function installHubOutboundEcho(page: Page, text: string) {
  const outboundId = `hub-outbound-echo-${text}`;
  const inject = async (route: Route) => {
    let before: number | undefined;
    try {
      const payload = route.request().postDataJSON() as { json?: { before?: number } } | null;
      before = payload?.json?.before;
    } catch {
      before = undefined;
    }
    try {
      const response = await route.fetch();
      const raw = await response.text();
      let body: { json?: HubThreadPage };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        await route.fulfill({ response, body: raw });
        return;
      }
      // Older history pages stay untouched so one echo is not copied onto every page.
      const targets =
        before !== undefined
          ? []
          : [body.json, body.json?.thread].filter((target): target is HubThreadPage =>
              Boolean(target && Array.isArray(target.messages)),
            );
      if (targets.length === 0) {
        await route.fulfill({ response, body: raw });
        return;
      }
      for (const pageBody of targets) {
        const messages = pageBody.messages;
        if (!messages || messages.some((message) => message.id === outboundId)) continue;
        const threadId = typeof pageBody.threadId === "string" ? pageBody.threadId : "thread";
        const botId =
          typeof pageBody.botId === "string"
            ? pageBody.botId
            : messages.find((message) => typeof message.botId === "string")?.botId;
        messages.push({
          id: outboundId,
          threadId,
          seq: 1_000_000,
          role: "bot",
          blocks: [
            {
              kind: "hub_message_sent",
              hubAgentId: "hub-atlas",
              name: "Atlas",
              text,
              intent: "request",
            },
          ],
          ...(typeof botId === "string" ? { botId } : {}),
          createdAt: new Date().toISOString(),
        });
      }
      const headers = response.headers();
      delete headers["content-length"];
      delete headers["content-encoding"];
      await route.fulfill({
        status: response.status(),
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Reload can cancel an in-flight intercepted request after fetch returns.
      if (/already handled|Target closed|Request context disposed/i.test(String(error))) return;
      throw error;
    }
  };
  // Reload paints bootstrap.thread and skips threads/get when that thread is the open bot.
  // One handler for both hydrate RPCs avoids overlapping globs racing on reload.
  await page.route(/\/rpc\/(bootstrap|threads\/get)(?:\?|$)/, inject);
  await page.route("**/rpc/threads/messages", inject);
}
