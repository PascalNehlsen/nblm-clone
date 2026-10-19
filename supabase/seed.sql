-- Local seed data. Tests create their own users and rows through the API with real
-- sign-ins, so nothing here can hide a missing policy. The one exception is the demo
-- template (block F, ADR 0012): only postgres can register it, and the RLS matrix and the
-- e2e tests need one. It is data, not policy. The constants mirror tests/rls/helpers/demo.ts.
-- max_live_copies is the allowed maximum locally, because every local test run leaves
-- anonymous notebooks behind until a db reset.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000d0',
  'authenticated', 'authenticated', 'demo-template-owner@example.test', '', now(),
  '', '', '', '',
  '{"provider":"email","providers":["email"]}', '{}', now(), now(), false
);

-- add_notebook_owner needs auth.uid(): act as the template owner for this transaction.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000d0","role":"authenticated"}', true);

insert into public.notebooks (id, title)
values ('00000000-0000-4000-8000-0000000000d1', 'Demo: Beispielquellen');

insert into public.sources (id, notebook_id, kind, title, status, created_by) values
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d1', 'text',
   'Beispiel: Der Wanderer.txt', 'ready', '00000000-0000-4000-8000-0000000000d0'),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d1', 'text',
   'Beispiel: Die Bibliothek.txt', 'ready', '00000000-0000-4000-8000-0000000000d0'),
  ('00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000d1', 'text',
   'Beispiel: Noch in Arbeit.txt', 'pending', '00000000-0000-4000-8000-0000000000d0');

-- 1024 zeros with a single 1.0 at `pos`.
insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
select '00000000-0000-4000-8000-0000000000d1', c.source_id, c.ordinal, c.content, null,
       ('[' || (select string_agg(case when g = c.pos then '1' else '0' end, ',' order by g)
                  from generate_series(0, 1023) g) || ']')::extensions.vector
  from (values
    ('00000000-0000-4000-8000-0000000000d2'::uuid, 0, 'Der Wanderer ging am Morgen los und folgte dem Fluss nach Norden.', 0),
    ('00000000-0000-4000-8000-0000000000d2'::uuid, 1, 'Am Mittag erreichte er eine alte Steinbruecke und rastete im Schatten.', 1),
    ('00000000-0000-4000-8000-0000000000d2'::uuid, 2, 'Am Abend sah er die Lichter des Dorfes und beschleunigte seinen Schritt.', 2),
    ('00000000-0000-4000-8000-0000000000d3'::uuid, 0, 'Die Bibliothek besass tausend Baende, die nach Farben und nicht nach Titeln geordnet waren.', 3),
    ('00000000-0000-4000-8000-0000000000d3'::uuid, 1, 'Die Bibliothekarin kannte jedes Buch und fand es im Dunkeln mit geschlossenen Augen.', 4),
    ('00000000-0000-4000-8000-0000000000d3'::uuid, 2, 'Im Winter las sie vor dem Ofen, und die Kinder des Dorfes hoerten zu.', 5),
    ('00000000-0000-4000-8000-0000000000d4'::uuid, 0, 'Dieser Text wird noch verarbeitet und darf nicht kopiert werden.', 6)
  ) as c(source_id, ordinal, content, pos);

insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
values ('00000000-0000-4000-8000-0000000000d1', 1000, 'seed', 'local demo template for tests');

select set_config('request.jwt.claims', '', true);
