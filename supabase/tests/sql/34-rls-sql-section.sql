-- Stage "rls-sql-section": supabase/rls.sql says its categories section is safe
-- to re-run on its own. run.sh extracts exactly that section and this stage
-- runs it twice on top of the migrated database (on the bigint shapes it is the
-- section that created the policies in the first place).
select medinv_t.stage('rls-sql-section');

do $$ begin perform medinv_t.save_snapshot('pre_rls_section'); end $$;

\i :rls_categories_file
\i :rls_categories_file

do $$ begin perform medinv_t.save_snapshot('post_rls_section'); end $$;

do $$
declare
  p medinv_t.snap%rowtype;
  q medinv_t.snap%rowtype;
begin
  select * into p from medinv_t.snap where label = 'pre_rls_section';
  select * into q from medinv_t.snap where label = 'post_rls_section';
  perform medinv_t.ok('RLS.SQL: its categories section runs twice in a row without error', true);
  perform medinv_t.ok('RLS.SQL: ...and leaves the structure identical (same two policies, same definitions)', p.catalog = q.catalog,
                      (select string_agg(l, ' | ') from (select unnest(q.catalog) except select unnest(p.catalog)) s(l)));
  perform medinv_t.eq('RLS.SQL: ...and the same behaviour for anon', medinv_t.matrix_diff(p.matrix_anon, q.matrix_anon), '');
  perform medinv_t.eq('RLS.SQL: ...and the same behaviour for authenticated', medinv_t.matrix_diff(p.matrix_auth, q.matrix_auth), '');
end $$;
