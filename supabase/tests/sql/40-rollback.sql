-- Stage "rollback": execute the rollback block that is documented in the
-- migration's header (run.sh extracts it between the <rollback-sql> markers),
-- confirm it restores the pre-migration state, then roll forward again.
-- Only run for shapes where the migration actually added something; on a fresh
-- install the "added" objects belong to schema.sql/rls.sql, not to the migration.
select medinv_t.stage('rollback');

do $$ begin perform medinv_t.save_snapshot('pre_rollback'); end $$;

\echo @@APPLY-BEGIN rollback
\i :rollback_file
\echo @@APPLY-END rollback

do $$ begin perform medinv_t.save_snapshot('post_rollback'); end $$;

do $$
declare
  e medinv_t.expectations := medinv_t.exp();
  b medinv_t.snap%rowtype;
  p medinv_t.snap%rowtype;
  q medinv_t.snap%rowtype;
begin
  select * into b from medinv_t.snap where label = 'before';
  select * into p from medinv_t.snap where label = 'pre_rollback';
  select * into q from medinv_t.snap where label = 'post_rollback';

  perform medinv_t.ok('ROLLBACK: the documented block restores the exact pre-migration structure',
                      q.catalog = b.catalog,
                      (select string_agg(l, ' | ') from (select unnest(q.catalog) except select unnest(b.catalog)
                                                          union all select '-' || l from (select unnest(b.catalog) except select unnest(q.catalog)) z(l)) s(l)));
  perform medinv_t.eq('ROLLBACK: the supplier_order_number column is gone',
                      (select count(*)::text from pg_attribute where attrelid = 'public.medications'::regclass
                          and attname = 'supplier_order_number' and not attisdropped), '0');
  perform medinv_t.eq('ROLLBACK: the categories policies are back to ' || e.policies_before,
                      (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'categories'), e.policies_before::text);
  perform medinv_t.eq('ROLLBACK: it leaves every original column of every row untouched',
                      q.data::text, p.data::text);
  perform medinv_t.eq('ROLLBACK: anon behaviour is back to the pre-migration behaviour (' ||
                      case when e.categories_rls then 'categories unreadable and not creatable again' else 'unchanged' end || ')',
                      medinv_t.matrix_diff(b.matrix_anon, q.matrix_anon), '');
end $$;

-- Running the block twice must be harmless.
\i :rollback_file
do $$ begin perform medinv_t.ok('ROLLBACK: the block can be run a second time without error', true); end $$;

-- Roll forward again: the migration applies cleanly after a rollback.
\echo @@APPLY-BEGIN roll-forward
\i :migration_file
\echo @@APPLY-END roll-forward

do $$ begin perform medinv_t.save_snapshot('rolled_forward'); end $$;

do $$
declare
  a medinv_t.snap%rowtype;
  f medinv_t.snap%rowtype;
begin
  select * into a from medinv_t.snap where label = 'after1';
  select * into f from medinv_t.snap where label = 'rolled_forward';
  perform medinv_t.ok('ROLLBACK: applying the migration again after a rollback gives the same structure as the first application',
                      f.catalog = a.catalog);
  perform medinv_t.eq('ROLLBACK: ...and the same anon behaviour', medinv_t.matrix_diff(a.matrix_anon, f.matrix_anon), '');
end $$;
