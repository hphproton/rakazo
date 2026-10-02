import { LinkifiedText } from "@rakazo/chat-ui/web";
import { BotAvatar, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import { LoadingState } from "./primitives";

/** Lightweight peer event shown without exposing the exchanged message body. */
export function CollaborationMarker({
  ariaLabel,
  color,
  identity,
  label,
  onClick,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  label: string;
  onClick?: () => void;
}) {
  const className =
    "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] text-muted-foreground";
  const body = (
    <>
      <BotAvatar color={color} identity={identity} size={16} />
      <span dir="auto" className="truncate">
        {label}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className="flex justify-start">
        <span data-testid="hub-outbound-chip" className={className}>
          {body}
        </span>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={ariaLabel}
        onClick={onClick}
        className={`${className} transition-colors hover:bg-accent hover:text-foreground/75`}
      >
        {body}
      </button>
    </div>
  );
}

/** Payload that left for a Hub member, with a destination marker. Not a peer chat. */
export function HubOutboundMessage({
  label,
  text,
  hubAgentId,
  color,
}: {
  label: string;
  text: string;
  hubAgentId: string;
  color: string;
}) {
  return (
    <div data-testid="hub-outbound" className="flex w-fit max-w-full flex-col items-start gap-1.5">
      <CollaborationMarker
        ariaLabel={label}
        color={color}
        identity={`hub:${hubAgentId}`}
        label={label}
      />
      <div className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full">
        <div
          data-testid="hub-outbound-text"
          className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] border border-border bg-background px-[18px] py-3 text-[15.5px] leading-[1.45] text-foreground"
          dir="auto"
        >
          <LinkifiedText>{text}</LinkifiedText>
        </div>
      </div>
    </div>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <LoadingState indicator={<GroupAvatar members={bots} size={28} />} label={label} />
    </div>
  );
}
