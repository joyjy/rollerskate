ALTER TABLE pairing_transactions
  ADD COLUMN oidc_device_code VARCHAR(2048) NULL AFTER verifier_hash,
  ADD COLUMN poll_interval_ms INTEGER NULL AFTER oidc_device_code,
  ADD COLUMN last_polled_at DATETIME(3) NULL AFTER poll_interval_ms;
