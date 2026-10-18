# Privacy

Personal data the app stores, where it lives, and how long. Every new data processor needs an entry here (AGENTS.md).

## Processors

| Processor | Region | Data |
|---|---|---|
| Supabase (Postgres, Auth, Storage) | Frankfurt | Accounts, notebooks, memberships, membership audit, sources, chunks with embeddings, chat messages |

Further processors (Vercel `fra1`, AWS Bedrock EU, Sentry EU) are added with the PRs that introduce them.

## Data

| Data | Where | Retention | On account deletion |
|---|---|---|---|
| Notebook memberships | `public.notebook_members` | While the membership exists | Deleted (foreign key cascade). A sole owner's notebooks are deleted too: account-deletion PR, open |
| Membership audit (who changed whose role, when) | `private.membership_audit`, no API access | 90 days, deleted by pg_cron: demo-login PR, open | User ids (`user_id`, `actor`) are set to null: account-deletion PR, open. No foreign keys, so the audit outlives deleted notebooks |
| Sources (title, kind, object path, status, creator) | `public.sources` | Until the source or its notebook is deleted | Notebooks the user owns alone: account-deletion PR, open. `created_by` is set to null on sources in other notebooks; the source stays with the notebook |
| Chunks: source text and its embedding (personal data, AGENTS.md) | `public.chunks` | Until the source or its notebook is deleted (foreign key cascade) | As sources |
| Chat messages (questions and answers) | `public.messages`, visible only to their author | Until the author deletes them, or the notebook or account is deleted | Deleted (foreign key cascade on `user_id`), once account deletion works for sole owners (account-deletion PR, open: the last-owner guard currently blocks the delete). A removed member's messages stay, invisible to everyone, until then |
| Citations (cited chunk, quoted passage) | `public.message_citations`, visible only to the message's author | Until the message is deleted. When the cited source is deleted, the quote is emptied and the answer's text is replaced with "Antwort entfernt, Quelle gelöscht". Only answers with a citation to a deleted chunk are replaced: source text the model reproduced without citing it, or that a user pasted into a question, stays | As messages |

Remaining gap: database backups (configured in a later PR) keep deleted sources, chunks, quotes and answer texts until the backup's retention ends.
