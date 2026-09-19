// Spike B verification helper — dump persisted session/message model data from an isolated opencode.db.
// Run: bun run inspect-db.ts <path-to-opencode.db>
import { Database } from "bun:sqlite"

const dbPath = process.argv[2]
if (!dbPath) {
  console.error("usage: bun run inspect-db.ts <opencode.db>")
  process.exit(1)
}

type MessageRow = { id: string; data: string }
type SessionRow = { id: string; model: string | null }

const db = new Database(dbPath)
const sessions = db.query("SELECT id, model FROM session").all() as SessionRow[]
for (const row of sessions) {
  console.log(`session ${row.id}: model=${row.model ?? "null"}`)
}

const messages = db.query("SELECT id, data FROM message ORDER BY id").all() as MessageRow[]
for (const row of messages) {
  const data = JSON.parse(row.data) as {
    role?: string
    model?: { providerID?: string; modelID?: string; variant?: string }
    providerID?: string
    modelID?: string
    agent?: string
  }
  const model = data.model
    ? `${data.model.providerID}/${data.model.modelID}${data.model.variant ? ` (variant=${data.model.variant})` : ""}`
    : data.providerID
      ? `${data.providerID}/${data.modelID}`
      : "none"
  console.log(`message ${row.id}: role=${data.role ?? "?"} agent=${data.agent ?? "?"} model=${model}`)
}
