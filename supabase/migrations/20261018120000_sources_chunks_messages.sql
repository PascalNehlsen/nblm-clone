-- Sources, chunks with embeddings and chat messages, all scoped to a notebook through
-- private.notebook_role, plus match_chunks for retrieval.
-- Decisions: docs/adr/0004-sources-chunks-messages.md.

create extension if not exists vector with schema extensions;

-- Tables -----------------------------------------------------------------------------

-- storage_path is the object key in the `sources` bucket (PR A2): {notebook_id}/{name},
-- one flat name without `..`, so no later path normalization reaches another notebook.
-- Pasted text is stored as a text/plain object too, so every source has one.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  kind text not null check (kind in ('pdf', 'text', 'url')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  storage_path text not null check (
    storage_path ~ ('^' || notebook_id::text || '/[A-Za-z0-9._-]+$')
    and position('..' in storage_path) = 0
  ),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  -- Target of the composite foreign key from chunks.
  unique (id, notebook_id)
);

create index sources_notebook_id_idx on public.sources (notebook_id);
-- For on delete set null when an account is deleted.
create index sources_created_by_idx on public.sources (created_by);

-- notebook_id is repeated here so policies and match_chunks filter without a join. The
-- composite foreign key keeps it equal to the source's notebook.
create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  source_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  -- Bounds direct inserts through PostgREST, which bypass ingestion (SECURITY.md).
  content text not null check (char_length(content) <= 8000),
  page integer,
  -- Amazon Titan Text Embeddings V2 at 1024 dimensions (ADR 0004).
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  foreign key (source_id, notebook_id)
    references public.sources (id, notebook_id) on delete cascade,
  unique (source_id, ordinal),
  -- Target of the composite foreign key from message_citations.
  unique (id, notebook_id)
);

-- No approximate vector index (HNSW, IVFFlat): match_chunks searches exactly within one
-- notebook through this btree. An approximate index filtered by notebook gives no recall
-- guarantee next to large notebooks (ADR 0004).
create index chunks_notebook_id_idx on public.chunks (notebook_id);

-- Tokens, cost and latency are not stored here: private.usage (PR E) keys them by
-- message id, so the client can neither read nor forge them.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 20000),
  created_at timestamptz not null default now(),
  -- Target of the composite foreign key from message_citations.
  unique (id, notebook_id)
);

create index messages_notebook_user_idx on public.messages (notebook_id, user_id, created_at);
-- For the cascade when an account is deleted.
create index messages_user_id_idx on public.messages (user_id);

-- A citation must not outlive its source: source text can be personal data. Deleting a
-- chunk sets chunk_id to null and the trigger below empties the quote, so the row stays
-- as a marker ("Quelle gelöscht"). The check makes this fail-safe: without the trigger,
-- deleting a cited chunk fails instead of leaving the quote behind.
create table public.message_citations (
  message_id uuid not null,
  notebook_id uuid not null,
  -- At most 20 citations per message: each one costs a foreign key update and two trigger
  -- calls when its source is deleted (SECURITY.md).
  ordinal integer not null check (ordinal between 1 and 20),
  chunk_id uuid,
  quote text check (char_length(quote) <= 2000),
  primary key (message_id, ordinal),
  foreign key (message_id, notebook_id)
    references public.messages (id, notebook_id) on delete cascade,
  foreign key (chunk_id, notebook_id)
    references public.chunks (id, notebook_id) on delete set null (chunk_id),
  check ((chunk_id is null) = (quote is null))
);

create index message_citations_chunk_id_idx on public.message_citations (chunk_id);

alter table public.sources enable row level security;
alter table public.chunks enable row level security;
alter table public.messages enable row level security;
alter table public.message_citations enable row level security;

-- Grants: creators, owners and notebook ids are not settable or movable from the API.
-- Chunks, messages and citations have no update grant; only the redaction trigger
-- (definer) rewrites an answer's text.
revoke all on public.sources, public.chunks, public.messages, public.message_citations
  from anon, authenticated;

grant select, delete on public.sources to authenticated;
grant insert (id, notebook_id, kind, title, storage_path) on public.sources to authenticated;
grant update (title, status) on public.sources to authenticated;

grant select, delete on public.chunks to authenticated;
grant insert (notebook_id, source_id, ordinal, content, page, embedding)
  on public.chunks to authenticated;

grant select, delete on public.messages to authenticated;
grant insert (id, notebook_id, role, content) on public.messages to authenticated;

grant select, delete on public.message_citations to authenticated;
grant insert (message_id, notebook_id, ordinal, chunk_id, quote)
  on public.message_citations to authenticated;

-- Policies: sources ------------------------------------------------------------------

create policy sources_select on public.sources
  for select to authenticated
  using (private.notebook_role(notebook_id) is not null);

create policy sources_insert on public.sources
  for insert to authenticated
  with check (
    private.notebook_role(notebook_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
  );

create policy sources_update on public.sources
  for update to authenticated
  using (private.notebook_role(notebook_id) in ('owner', 'editor'))
  with check (private.notebook_role(notebook_id) in ('owner', 'editor'));

create policy sources_delete on public.sources
  for delete to authenticated
  using (private.notebook_role(notebook_id) in ('owner', 'editor'));

-- Anonymous (demo) users do not write sources or chunks: uploads and embeddings are the
-- cost and abuse path. PR F decides whether demo users may upload into their own copy.
create policy sources_insert_not_anonymous on public.sources
  as restrictive
  for insert to authenticated
  with check (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

create policy sources_update_not_anonymous on public.sources
  as restrictive
  for update to authenticated
  using (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false)
  with check (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

create policy sources_delete_not_anonymous on public.sources
  as restrictive
  for delete to authenticated
  using (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

-- Policies: chunks -------------------------------------------------------------------

create policy chunks_select on public.chunks
  for select to authenticated
  using (private.notebook_role(notebook_id) is not null);

create policy chunks_insert on public.chunks
  for insert to authenticated
  with check (private.notebook_role(notebook_id) in ('owner', 'editor'));

-- No update grant, so this policy never applies; it exists so every command has one.
create policy chunks_update on public.chunks
  for update to authenticated
  using (private.notebook_role(notebook_id) in ('owner', 'editor'))
  with check (private.notebook_role(notebook_id) in ('owner', 'editor'));

create policy chunks_delete on public.chunks
  for delete to authenticated
  using (private.notebook_role(notebook_id) in ('owner', 'editor'));

create policy chunks_insert_not_anonymous on public.chunks
  as restrictive
  for insert to authenticated
  with check (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

create policy chunks_delete_not_anonymous on public.chunks
  as restrictive
  for delete to authenticated
  using (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

-- Policies: messages -----------------------------------------------------------------

-- History is per user: other members never see each other's questions. Viewers may ask;
-- the asker's own budget pays (PR E). The server writes assistant rows with the user's
-- login, so a user can also forge assistant rows in their own history (SECURITY.md).
create policy messages_select on public.messages
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and private.notebook_role(notebook_id) is not null
  );

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.notebook_role(notebook_id) is not null
  );

-- No update grant, so this policy never applies; it exists so every command has one.
create policy messages_update on public.messages
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and private.notebook_role(notebook_id) is not null
  )
  with check (
    user_id = (select auth.uid())
    and private.notebook_role(notebook_id) is not null
  );

create policy messages_delete on public.messages
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and private.notebook_role(notebook_id) is not null
  );

-- Policies: message_citations -------------------------------------------------------

-- Same visibility as the cited message: its author, while a member. The exists reads
-- messages under the caller's RLS, which only shows their own rows.
create policy message_citations_select on public.message_citations
  for select to authenticated
  using (
    private.notebook_role(notebook_id) is not null
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.user_id = (select auth.uid())
    )
  );

create policy message_citations_insert on public.message_citations
  for insert to authenticated
  with check (
    chunk_id is not null
    and private.notebook_role(notebook_id) is not null
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.user_id = (select auth.uid())
    )
  );

-- No update grant, so this policy never applies; it exists so every command has one.
create policy message_citations_update on public.message_citations
  for update to authenticated
  using (
    private.notebook_role(notebook_id) is not null
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.user_id = (select auth.uid())
    )
  )
  with check (
    private.notebook_role(notebook_id) is not null
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.user_id = (select auth.uid())
    )
  );

create policy message_citations_delete on public.message_citations
  for delete to authenticated
  using (
    private.notebook_role(notebook_id) is not null
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.user_id = (select auth.uid())
    )
  );

-- Triggers: deleted sources --------------------------------------------------------

-- Invoker: it only changes the row being updated by the foreign key action.
create function private.clear_citation_quote()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.chunk_id is null then
    new.quote := null;
  end if;
  return new;
end
$$;

revoke execute on function private.clear_citation_quote() from public, anon, authenticated;

create trigger message_citations_clear_quote
  before update of chunk_id on public.message_citations
  for each row execute function private.clear_citation_quote();

-- An answer that cited a deleted source may quote it verbatim, so its text is replaced.
-- Security definer (ADR 0001 trigger exception): inside the foreign key action the
-- trigger runs as the deleting user, who has no update grant on messages, so an invoker
-- version makes the source deletion fail with "permission denied" (measured); with a
-- grant, RLS would silently skip other members' messages instead. It only replaces the
-- content of assistant messages.
create function private.redact_cited_answers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.messages
  set content = 'Antwort entfernt, Quelle gelöscht'
  where id = new.message_id
    and role = 'assistant';
  return null;
end
$$;

revoke execute on function private.redact_cited_answers() from public, anon, authenticated;

create trigger message_citations_redact_answer
  after update of chunk_id on public.message_citations
  for each row
  when (old.chunk_id is not null and new.chunk_id is null)
  execute function private.redact_cited_answers();

-- Retrieval --------------------------------------------------------------------------

-- Security invoker: RLS on chunks still applies, so a non-member gets no rows for any
-- notebook id. The explicit notebook filter uses the btree; the distance is computed for
-- every chunk of that notebook, so the result is exact (ADR 0004).
create function public.match_chunks(
  query_embedding extensions.vector(1024),
  p_notebook_id uuid,
  match_count integer default 8
)
returns table (
  id uuid,
  source_id uuid,
  ordinal integer,
  content text,
  page integer,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.source_id,
    c.ordinal,
    c.content,
    c.page,
    1 - (c.embedding operator(extensions.<=>) query_embedding)
  from public.chunks c
  where c.notebook_id = p_notebook_id
  order by c.embedding operator(extensions.<=>) query_embedding, c.id
  limit least(greatest(coalesce(match_count, 8), 1), 50)
$$;

revoke execute on function public.match_chunks(extensions.vector, uuid, integer)
  from public, anon;
grant execute on function public.match_chunks(extensions.vector, uuid, integer)
  to authenticated;
