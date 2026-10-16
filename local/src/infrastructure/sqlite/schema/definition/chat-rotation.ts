export const chatRotationSchemaSql = `
    CREATE TABLE IF NOT EXISTS chat_rotations (
      topic_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL CHECK(
        json_valid(state_json) AND length(state_json) <= 262144
      ),
      updated_at TEXT NOT NULL
    );
`;
