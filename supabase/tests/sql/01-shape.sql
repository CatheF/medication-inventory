-- Stage "shape": prove the fixture really is the shape this run claims to be.
-- Without this, a fixture that silently drifted (say, a schema.sql that stopped
-- creating a policy) would make the later "nothing changed" checks hold
-- vacuously. Runs before any data exists.
select medinv_t.stage('shape');

do $$
declare
  e medinv_t.expectations := medinv_t.exp();
  v text;
  n int;
begin
  perform medinv_t.ok('shape ' || coalesce(e.shape, '<unknown>') || ': known fixture shape', e.shape is not null);

  select format_type(atttypid, atttypmod) into v from pg_attribute
   where attrelid = 'public.categories'::regclass and attname = 'id';
  perform medinv_t.eq('shape: categories.id is ' || e.id_type, v, e.id_type);

  select format_type(atttypid, atttypmod) into v from pg_attribute
   where attrelid = 'public.medications'::regclass and attname = 'category_id';
  perform medinv_t.eq('shape: medications.category_id is ' || e.id_type || ' too', v, e.id_type);

  select relrowsecurity::text into v from pg_class where oid = 'public.categories'::regclass;
  perform medinv_t.eq('shape: row level security on categories is ' || case when e.categories_rls then 'ENABLED' else 'off' end,
                      v, e.categories_rls::text);

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'categories';
  perform medinv_t.eq('shape: categories has ' || e.policies_before || ' policies before the migration', n::text, e.policies_before::text);

  select count(*) into n from pg_attribute
   where attrelid = 'public.medications'::regclass and attname = 'supplier_order_number' and not attisdropped;
  perform medinv_t.eq('shape: medications.supplier_order_number ' || case when e.column_before then 'already exists' else 'does not exist yet' end,
                      (n = 1)::text, e.column_before::text);

  select confdeltype::text into v from pg_constraint
   where conrelid = 'public.medications'::regclass and contype = 'f' and confrelid = 'public.categories'::regclass;
  perform medinv_t.eq('shape: FK medications.category_id -> categories is ON DELETE ' ||
                      case e.fk_delete_rule when 'a' then 'NO ACTION (as deployed)' else 'SET NULL (as in schema.sql)' end,
                      v, e.fk_delete_rule::text);

  -- Baseline the migration must leave alone.
  perform medinv_t.eq('shape: medications has RLS on with 4 anon policies (select/insert/update/delete)',
    (select relrowsecurity::text || '/' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'medications')
       from pg_class where oid = 'public.medications'::regclass), 'true/4');
  perform medinv_t.eq('shape: transactions has RLS on with 1 policy (select only)',
    (select relrowsecurity::text || '/' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'transactions')
       from pg_class where oid = 'public.transactions'::regclass), 'true/1');

  if e.shape = 'repo_fresh' then
    -- The fresh-install files themselves must deliver what the migration would add.
    select format_type(atttypid, atttypmod) || '/' || attnotnull || '/' || atthasdef into v from pg_attribute
     where attrelid = 'public.medications'::regclass and attname = 'supplier_order_number';
    perform medinv_t.eq('shape: schema.sql creates supplier_order_number as nullable text with no default', v, 'text/false/false');

    select string_agg(policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '-') || ':' || coalesce(with_check, '-'),
                      ' | ' order by policyname) into v
      from pg_policies where schemaname = 'public' and tablename = 'categories';
    perform medinv_t.eq('shape: rls.sql creates the two categories policies the migration would add', v,
      'anon: insert categories:INSERT:{anon}:-:true | anon: read categories:SELECT:{anon}:true:-');
  end if;
end $$;
