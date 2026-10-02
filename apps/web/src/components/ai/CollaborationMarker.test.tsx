import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker, HubOutboundMessage } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a left-aligned peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        ariaLabel="Message from Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex justify-start"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain('class="truncate"');
    expect(html).toContain("rakazo-bot-avatar");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
  });

  it("shows the Hub payload and destination without a peer-chat control", () => {
    const html = renderToString(
      <HubOutboundMessage
        label="To Hub · Box Principal"
        text="NATIVE_HUB_SEND_SMOKE"
        hubAgentId="box-principal"
        color="#85858A"
      />,
    );

    expect(html).toContain('data-testid="hub-outbound"');
    expect(html).toContain('data-testid="hub-outbound-chip"');
    expect(html).toContain("To Hub · Box Principal");
    expect(html).toContain('data-testid="hub-outbound-text"');
    expect(html).toContain("NATIVE_HUB_SEND_SMOKE");
    expect(html).not.toContain('data-testid="peer-receipt-chip"');
    expect(html).not.toContain("<button");
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Research is working"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-working="true"');
    expect(html).toContain("rakazo-bot-avatar-ring");
  });
});
