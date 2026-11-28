-- Phase H.1: numeric and checksum invariants that can be enforced in the
-- database without rejecting any value produced by the application.
ALTER TABLE "AffiliateConversion"
  ADD CONSTRAINT "AffiliateConversion_amount_nonnegative" CHECK ("amountCents" >= 0),
  ADD CONSTRAINT "AffiliateConversion_commission_nonnegative" CHECK ("commissionCents" IS NULL OR "commissionCents" >= 0);

ALTER TABLE "AffiliateLink"
  ADD CONSTRAINT "AffiliateLink_commission_bps_range" CHECK ("commissionBps" IS NULL OR ("commissionBps" >= 0 AND "commissionBps" <= 10000));

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_checksum_format" CHECK ("checksum" IS NULL OR "checksum" ~ '^sha256:[a-f0-9]{64}$');
