-- Phase G autonomous pipeline jobs are executed by the background engine.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PHASE_G_PIPELINE';
