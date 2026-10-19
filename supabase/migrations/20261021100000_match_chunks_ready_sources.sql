-- Block D1: match_chunks returns only chunks of sources whose ingestion finished
-- (status 'ready'). Before, chunks of a source still processing, re-ingesting or failed
-- after its insert could be retrieved and later cited (C3 known gap). Same signature,
-- return type and properties, so the previous app version keeps working.
-- The filter sits in SQL, not in the app: filtering after the limit would let chunks of
-- unfinished sources push ready ones out of the top k.

create or replace function public.match_chunks(
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
  join public.sources s
    on s.id = c.source_id
   and s.notebook_id = c.notebook_id
  where c.notebook_id = p_notebook_id
    and s.status = 'ready'
  order by c.embedding operator(extensions.<=>) query_embedding, c.id
  limit least(greatest(coalesce(match_count, 8), 1), 50)
$$;

revoke execute on function public.match_chunks(extensions.vector, uuid, integer)
  from public, anon;
grant execute on function public.match_chunks(extensions.vector, uuid, integer)
  to authenticated;
