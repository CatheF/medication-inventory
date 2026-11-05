-- Stage "after-second-apply": apply the migration a second time. A re-run must
-- be a complete no-op: same structure, same data, same behaviour.
select medinv_t.stage('after-second-apply');

\echo @@APPLY-BEGIN second
\i :migration_file
\echo @@APPLY-END second

do $$ begin perform medinv_t.save_snapshot('after2'); end $$;

do $$
declare
  a1 medinv_t.snap%rowtype;
  a2 medinv_t.snap%rowtype;
  n bigint;
begin
  select * into a1 from medinv_t.snap where label = 'after1';
  select * into a2 from medinv_t.snap where label = 'after2';

  perform medinv_t.ok('re-applying changes no structure (columns, constraints, indexes, policies, RLS flags, privileges, functions)',
                      a1.catalog = a2.catalog,
                      (select string_agg(l, ' | ') from (select unnest(a2.catalog) except select unnest(a1.catalog)) s(l)));
  perform medinv_t.eq('re-applying changes no data', a2.data::text, a1.data::text);
  perform medinv_t.eq('re-applying changes no behaviour for anon (every probe gives the same outcome)',
                      medinv_t.matrix_diff(a1.matrix_anon, a2.matrix_anon), '');
  perform medinv_t.eq('re-applying changes no behaviour for authenticated',
                      medinv_t.matrix_diff(a1.matrix_auth, a2.matrix_auth), '');

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'categories' and policyname in ('anon: read categories', 'anon: insert categories');
  perform medinv_t.eq('still exactly one "anon: read categories" and one "anon: insert categories" policy (no duplicates)', n::text, '2');
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'categories';
  perform medinv_t.eq('still exactly 2 policies on categories in total', n::text, '2');
  select count(*) into n from pg_attribute
   where attrelid = 'public.medications'::regclass and attname = 'supplier_order_number' and not attisdropped;
  perform medinv_t.eq('still exactly one supplier_order_number column', n::text, '1');
end $$;
