# Security

How this app handles the risks of an LLM application. The mapping to the OWASP Top 10 for LLM Applications comes with the chat PR (D); the rules themselves are in AGENTS.md ("Hard rules: AI and data security").

To report a vulnerability, open a private security advisory on GitHub.

## Accepted risks

| Risk | Why accepted | Bounded by | Since |
|---|---|---|---|
| A user can insert fake `assistant` messages into their own chat history through PostgREST | The server writes messages with the user's login, so RLS guards every write; a separate writer role would bypass RLS ([ADR 0004](docs/adr/0004-sources-chunks-messages.md)) | History is per user, so only the forger sees them; rendering rules apply to every message (no raw HTML, no remote content, links http(s) only); a forged row never reaches the model as a source. If PR D sends chat history to the model, forged rows reach it as the forger's own conversation context, in their own session and on their own budget; PR D decides whether history comes only from rows it wrote | PR A1 |
| An editor can insert chunks directly through PostgREST, bypassing ingestion: no upload size limit, no magic-byte check, and an embedding that need not match the text, so a chunk can be retrieved for any question | Ingestion writes chunks with the user's login | Only owners and editors of that notebook, never viewers, strangers or anonymous users; `content` is capped at 8,000 characters; the 20,000-chunk cap per notebook must be enforced in the database in PR C, not only in ingestion code. A planted chunk affects only that notebook's answers, which the editor could already shape through their sources | PR A1 |
| Members, including anonymous demo users, can insert messages and citations in a loop without a model call. Many citations to one chunk also slow down deleting that source (one foreign key update and two trigger calls per citation) and could push the deletion past the statement timeout | Messages and citations are written with the user's login; the budget check guards model calls, not inserts | `content` is capped at 20,000 characters, quotes at 2,000, citations at 20 per message; history is per user; the number of messages is not capped yet: a per-user insert rate limit covering messages and citations is open for PR E or F | PR A1 |
| A user can insert citations with arbitrary quotes for their own messages through PostgREST | Same as fake assistant messages: the server writes citations with the user's login | Only for the user's own messages, only chunks of the same notebook (foreign key), quotes capped at 2,000 characters; PR D validates citations server-side when it writes them | PR A1 |
