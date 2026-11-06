-- Stage "after-first-apply": apply the migration once, then prove it only ADDED
-- what it promises and altered nothing that existed.
select medinv_t.stage('after-first-apply');

-- The @@APPLY markers let run.sh count the NOTIFY pgrst notifications that this
-- one application delivered, and nothing else (see "notifications_in" there).
\echo @@APPLY-BEGIN first
\i :migration_file
\echo @@APPLY-END first

do $$ begin perform medinv_t.save_snapshot('after1'); end $$;

do $$
declare
  e medinv_t.expectations := medinv_t.exp();
  b medinv_t.snap%rowtype;
  a medinv_t.snap%rowtype;
  removed text;
  expected text[] := '{}';
  added text[];
  v text;
  n bigint;
  attnum_ smallint;
begin
  select * into b from medinv_t.snap where label = 'before';
  select * into a from medinv_t.snap where label = 'after1';

  -- ── Existing data is untouched ────────────────────────────────────────────
  perform medinv_t.eq(format('existing items are byte-identical: %s rows, md5 over each row''s every original column incl. created_at/updated_at',
                             b.data #>> '{counts,medications}'), a.data->>'medications', b.data->>'medications');
  perform medinv_t.eq(format('existing stock history is byte-identical: %s transaction rows', b.data #>> '{counts,transactions}'),
                      a.data->>'transactions', b.data->>'transactions');
  perform medinv_t.eq(format('existing categories are byte-identical: %s rows, none renamed, merged or deleted', b.data #>> '{counts,categories}'),
                      a.data->>'categories', b.data->>'categories');
  perform medinv_t.eq('row counts unchanged in every table', (a.data->'counts')::text, (b.data->'counts')::text);

  -- ── Structure: purely additive ────────────────────────────────────────────
  select string_agg(l, ' | ' order by l) into removed from medinv_t.catalog_removed('before', 'after1') l;
  perform medinv_t.ok('structure: nothing that existed was removed or altered (no type, nullability, default, constraint, index, trigger, function, RLS or privilege change)',
                      removed is null, removed);

  if not e.column_before then
    expected := array_append(expected, 'col medications.supplier_order_number text notnull=f default=-');
  end if;
  if e.policies_before = 0 then
    expected := expected || array[
      'pol categories."anon: insert categories" permissive=PERMISSIVE cmd=INSERT roles={anon} using=- check=true',
      'pol categories."anon: read categories" permissive=PERMISSIVE cmd=SELECT roles={anon} using=true check=-'];
  end if;
  expected := array(select x from unnest(expected) x order by x);
  added := array(select l from medinv_t.catalog_added('before', 'after1') l order by l);
  perform medinv_t.ok(case when cardinality(expected) = 0
                           then 'structure: nothing to add in this shape (schema.sql + rls.sql already provide it), so the migration changes nothing'
                           else format('structure: exactly %s additions: %s', cardinality(expected),
                                       case when e.column_before then '' else 'the supplier_order_number column' || case when e.policies_before = 0 then ' and ' else '' end end ||
                                       case when e.policies_before = 0 then 'the two categories policies' else '' end) end,
                      added = expected, 'added=' || array_to_string(added, ' | '));

  -- ── supplier_order_number ────────────────────────────────────────────────
  select a2.attnum, format_type(a2.atttypid, a2.atttypmod) || '/' || a2.attnotnull || '/' || a2.atthasdef
    into attnum_, v
    from pg_attribute a2
   where a2.attrelid = 'public.medications'::regclass and a2.attname = 'supplier_order_number' and not a2.attisdropped;
  perform medinv_t.eq('supplier_order_number is TEXT (so leading zeros survive), nullable, no default', v, 'text/false/false');

  select count(*) into n from pg_constraint where conrelid = 'public.medications'::regclass and attnum_ = any (conkey);
  perform medinv_t.eq('supplier_order_number has no constraint (no UNIQUE, no CHECK, no FK)', n::text, '0');
  select count(*) into n from pg_index where indrelid = 'public.medications'::regclass and attnum_ = any (indkey::smallint[]);
  perform medinv_t.eq('supplier_order_number has no index', n::text, '0');

  select count(*) into n from public.medications where supplier_order_number is not null;
  perform medinv_t.eq(format('all %s existing items have supplier_order_number NULL (the app shows "Not set"; nothing inferred from barcodes or names)',
                             b.data #>> '{counts,medications}'), n::text, '0');

  perform medinv_t.ok('supplier_order_number carries a column comment that says it is not the barcode',
                      coalesce(col_description('public.medications'::regclass, attnum_), '') ilike '%distinct from barcode%',
                      col_description('public.medications'::regclass, attnum_));

  -- ── Row level security ───────────────────────────────────────────────────
  select relrowsecurity::text into v from pg_class where oid = 'public.categories'::regclass;
  perform medinv_t.eq('RLS on categories is still ' || case when e.categories_rls then 'ENABLED' else 'off' end ||
                      ' (the migration never toggles it)', v, e.categories_rls::text);
  perform medinv_t.eq('RLS on medications and transactions is still enabled',
                      (select string_agg(relname || '=' || relrowsecurity, ',' order by relname) from pg_class
                        where oid in ('public.medications'::regclass, 'public.transactions'::regclass)),
                      'medications=true,transactions=true');

  -- ── The two policies are exactly SELECT + INSERT for anon ────────────────
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'categories';
  perform medinv_t.eq('categories has exactly 2 policies after the migration', n::text, '2');
  select string_agg(policyname || ':' || cmd || ':' || roles::text || ':' || permissive, ' | ' order by policyname) into v
    from pg_policies where schemaname = 'public' and tablename = 'categories';
  perform medinv_t.eq('the 2 policies are SELECT and INSERT, for role anon only, permissive', v,
    'anon: insert categories:INSERT:{anon}:PERMISSIVE | anon: read categories:SELECT:{anon}:PERMISSIVE');
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'categories' and (cmd in ('UPDATE', 'DELETE', 'ALL') or roles <> '{anon}');
  perform medinv_t.eq('no UPDATE, DELETE or ALL policy on categories, and none for authenticated or public', n::text, '0');

  -- ── Everything else that existed is byte-for-byte the same definition ────
  perform medinv_t.ok('policies on medications and transactions are unchanged',
    not exists (select 1 from medinv_t.catalog_added('before', 'after1') l where l like 'pol medications.%' or l like 'pol transactions.%')
    and not exists (select 1 from medinv_t.catalog_removed('before', 'after1') l where l like 'pol medications.%' or l like 'pol transactions.%'));
  perform medinv_t.ok('record_transaction and set_updated_at are unchanged (definition, SECURITY DEFINER flag, privileges)',
    not exists (select 1 from medinv_t.catalog_added('before', 'after1') l where l like 'fn %')
    and not exists (select 1 from medinv_t.catalog_removed('before', 'after1') l where l like 'fn %'));
  perform medinv_t.ok('the FK from medications.category_id to categories is unchanged',
    not exists (select 1 from medinv_t.catalog_added('before', 'after1') l where l like 'con medications.%category%')
    and not exists (select 1 from medinv_t.catalog_removed('before', 'after1') l where l like 'con medications.%category%'));
end $$;
