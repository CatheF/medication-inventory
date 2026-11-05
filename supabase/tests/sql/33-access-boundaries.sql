-- Stage "access-boundaries": what each API role can do, found by trying it, and
-- what changed compared with before the migration.
select medinv_t.stage('access-boundaries');

do $$
declare
  e medinv_t.expectations := medinv_t.exp();
  b medinv_t.snap%rowtype;
  m_anon jsonb := medinv_t.privilege_matrix('anon');
  m_auth jsonb := medinv_t.privilege_matrix('authenticated');
  d text;
begin
  select * into b from medinv_t.snap where label = 'before';

  -- ── What anon gained ────────────────────────────────────────────────────
  d := medinv_t.matrix_diff(b.matrix_anon, m_anon);
  if e.categories_rls and e.policies_before = 0 then
    perform medinv_t.eq('ACCESS: the only things anon gained are SELECT and INSERT on categories (13 probes compared before/after)', d,
                        'categories.insert(err:42501->ok:some), categories.select(ok:none->ok:some)');
  else
    perform medinv_t.eq('ACCESS: anon gained nothing in this shape (RLS was never blocking categories here; 13 probes compared before/after)', d, '');
  end if;
  perform medinv_t.eq('ACCESS: the authenticated role gained nothing (the migration grants only to anon)',
                      medinv_t.matrix_diff(b.matrix_auth, m_auth), '');

  -- ── Existing boundaries still hold ──────────────────────────────────────
  perform medinv_t.eq('ACCESS: medications - anon keeps full CRUD',
                      m_anon->>'medications.select' || ',' || (m_anon->>'medications.insert') || ',' || (m_anon->>'medications.update') || ',' || (m_anon->>'medications.delete'),
                      'ok:some,ok:some,ok:some,ok:some');
  perform medinv_t.eq('ACCESS: transactions - anon stays read-only (select ok; insert refused 42501; update and delete touch 0 rows)',
                      m_anon->>'transactions.select' || ',' || (m_anon->>'transactions.insert') || ',' || (m_anon->>'transactions.update') || ',' || (m_anon->>'transactions.delete'),
                      'ok:some,err:42501,ok:none,ok:none');
  perform medinv_t.eq('ACCESS: record_transaction stays callable by anon', m_anon->>'rpc.record_transaction', 'ok:some');

  -- ── Categories: least privilege where RLS is on ─────────────────────────
  if e.categories_rls then
    perform medinv_t.assert_categories_least_privilege('ACCESS: categories (RLS enabled, as deployed)');
  else
    perform medinv_t.eq('ACCESS: categories - RLS is off in this shape, so anon keeps the table-level access it always had (read, create, rename, delete)',
                        m_anon->>'categories.select' || ',' || (m_anon->>'categories.insert') || ',' || (m_anon->>'categories.update') || ',' || (m_anon->>'categories.delete'),
                        'ok:some,ok:some,ok:some,ok:some');
  end if;
end $$;

-- ── The policies are sufficient on their own when RLS is switched on ───────
-- (A no-op on the deployed shape, where it already is on. Rolled back.)
begin;
alter table public.categories enable row level security;
do $$ begin perform medinv_t.assert_categories_least_privilege('POLICIES ALONE (RLS switched on for categories)'); end $$;
rollback;

-- ── Why both policies are needed ───────────────────────────────────────────
begin;
alter table public.categories enable row level security;
drop policy "anon: read categories" on public.categories;
do $$
begin
  perform medinv_t.eq('WHY: without the SELECT policy, INSERT ... RETURNING is refused (42501), so the INSERT policy alone is not enough',
                      medinv_t.probe('anon', $q$insert into public.categories (name) values ('Only-Insert') returning id$q$), 'err:42501');
  perform medinv_t.eq('WHY: ...and without it anon sees no categories',
                      medinv_t.scalar_as('anon', 'select count(*) from public.categories'), '0');
end $$;
rollback;

begin;
alter table public.categories enable row level security;
drop policy "anon: insert categories" on public.categories;
do $$
begin
  perform medinv_t.eq('WHY: without the INSERT policy anon can still read categories but creating one is refused (42501)',
                      medinv_t.probe('anon', $q$insert into public.categories (name) values ('Only-Read')$q$)
                        || ' / ' || medinv_t.probe('anon', 'select * from public.categories'),
                      'err:42501 / ok:some');
end $$;
rollback;
