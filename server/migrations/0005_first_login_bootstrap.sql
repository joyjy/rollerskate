CREATE TABLE IF NOT EXISTS deployment_bootstrap (
  id TINYINT NOT NULL PRIMARY KEY,
  admin_human_id VARCHAR(64) NULL,
  claimed_at DATETIME(3) NULL,
  CONSTRAINT deployment_bootstrap_singleton CHECK (id = 1),
  CONSTRAINT deployment_bootstrap_admin_fk
    FOREIGN KEY (admin_human_id) REFERENCES humans (id)
);

INSERT INTO deployment_bootstrap (id, admin_human_id, claimed_at)
SELECT
  1,
  (
    SELECT id
    FROM humans
    WHERE is_admin = TRUE
    ORDER BY created_at, id
    LIMIT 1
  ),
  CASE
    WHEN EXISTS (SELECT 1 FROM humans WHERE is_admin = TRUE)
    THEN CURRENT_TIMESTAMP(3)
    ELSE NULL
  END
ON DUPLICATE KEY UPDATE id = VALUES(id);
