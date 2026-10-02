import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

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
    expect(html).toContain("inline-flex max-w-full");
    expect(html).toContain('class="truncate"');
    expect(html).toContain("rakazo-bot-avatar");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
  });

  it("styles an outbound Hub receipt as the same chip, without a payload bubble", () => {
    const html = renderToString(
      <CollaborationMarker
        ariaLabel="To Hub · Box Principal"
        color="#85858A"
        identity="box-principal"
        label="To Hub · Box Principal"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="To Hub · Box Principal"');
    expect(html).toContain("To Hub · Box Principal");
    expect(html).toContain("<button");
    expect(html).not.toContain('data-testid="hub-outbound"');
    expect(html).not.toContain('data-testid="hub-outbound-text"');
    expect(html).not.toContain("NATIVE_HUB_SEND_SMOKE");
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
