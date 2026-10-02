CREATE TABLE "hub_outbound" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "fromBotName" TEXT NOT NULL,
    "hubAgentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "threadKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'wake',
    "idempotencyKey" TEXT,
    "meshId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hub_outbound_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hub_outbound_idempotencyKey_key" ON "hub_outbound"("idempotencyKey");
CREATE INDEX "hub_outbound_spaceId_userId_status_createdAt_idx" ON "hub_outbound"("spaceId", "userId", "status", "createdAt");

ALTER TABLE "hub_outbound" ADD CONSTRAINT "hub_outbound_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
