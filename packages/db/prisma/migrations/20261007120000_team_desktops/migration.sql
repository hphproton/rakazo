CREATE TABLE "team_desktops" (
    "botId" TEXT NOT NULL,
    "displayIndex" INTEGER NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_desktops_pkey" PRIMARY KEY ("botId")
);

CREATE UNIQUE INDEX "team_desktops_displayIndex_key" ON "team_desktops"("displayIndex");
CREATE INDEX "team_desktops_state_lastUsedAt_idx" ON "team_desktops"("state", "lastUsedAt");

ALTER TABLE "team_desktops" ADD CONSTRAINT "team_desktops_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_desktops" ADD CONSTRAINT "team_desktops_display_range_check" CHECK ("displayIndex" BETWEEN 101 AND 150);
ALTER TABLE "team_desktops" ADD CONSTRAINT "team_desktops_state_check" CHECK ("state" IN ('reserved', 'running', 'stopped', 'releasing'));
