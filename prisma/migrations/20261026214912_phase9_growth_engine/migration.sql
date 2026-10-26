-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "metric" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentMeasurement" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Experiment_workspaceId_idx" ON "Experiment"("workspaceId");

-- CreateIndex
CREATE INDEX "Insight_workspaceId_idx" ON "Insight"("workspaceId");

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentMeasurement" ADD CONSTRAINT "ExperimentMeasurement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ExperimentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
