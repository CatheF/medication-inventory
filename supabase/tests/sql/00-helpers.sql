-- Test helpers, loaded by run.sh into every throwaway database first.
-- Everything lives in schema medinv_t, so none of it can be mistaken for (or
-- leak into) the app's own public schema, and the catalog fingerprints below
-- only look at public.
--
-- Reporting convention: every assertion prints exactly one line starting with
-- "PASS  " or "FAIL  " as a NOTICE. run.sh counts those lines. An assertion
-- failing does not stop the run; an unexpected SQL error does (ON_ERROR_STOP).

\if :{?shape}
\else
  \echo 'run.sh must pass -v shape=<live|repo_legacy|repo_fresh>'
  \quit 3
\endif

select set_config('medinv_t.shape', :'shape', false) \gset

-- The migration ends with NOTIFY pgrst. Listening here lets run.sh see that the
-- notification really is delivered when the migration commits.
listen pgrst;

create schema medinv_t;

-- ── What each shape must look like BEFORE the migration ──────────────────────
-- live        the deployed Health Center database: uuid ids, RLS on categories
--             with no policy, no supplier column, FK without ON DELETE SET NULL.
-- repo_legacy a bigint database provisioned from supabase/schema.sql and rls.sql and
--             then stripped of what the migration adds: no supplier column, no
--             categories policies.
-- repo_fresh  a bigint database provisioned from the current schema.sql + rls.sql:
--             the migration has nothing left to add.
create table medinv_t.expectations (
  shape          text primary key,
  id_type        text    not null,   -- type of categories.id and medications.category_id
  categories_rls boolean not null,   -- relrowsecurity on categories before the migration
  policies_before int    not null,   -- policies on categories before the migration
  column_before  boolean not null,   -- medications.supplier_order_number exists before
  fk_delete_rule "char"  not null    -- pg_constraint.confdeltype: a = NO ACTION, n = SET NULL
);
insert into medinv_t.expectations values
  ('live',        'uuid',   true,  0, false, 'a'),
  ('repo_legacy', 'bigint', false, 0, false, 'n'),
  ('repo_fresh',  'bigint', false, 2, true,  'n');

create function medinv_t.exp() returns medinv_t.expectations
language sql stable as $$
  select * from medinv_t.expectations where shape = current_setting('medinv_t.shape')
$$;

-- ── Reporting ────────────────────────────────────────────────────────────────
create function medinv_t.stage(p_name text) returns void
language plpgsql as $$
begin
  raise notice '[STAGE] %', p_name;
end $$;

create function medinv_t.ok(p_name text, p_ok boolean, p_detail text default null) returns void
language plpgsql as $$
begin
  if p_ok is true then
    raise notice 'PASS  %', p_name;
  else
    raise notice 'FAIL  %', p_name || coalesce('  [' || p_detail || ']', '');
  end if;
end $$;

create function medinv_t.eq(p_name text, p_got text, p_expected text) returns void
language plpgsql as $$
begin
  perform medinv_t.ok(p_name, p_got is not distinct from p_expected,
                      format('expected %L, got %L', p_expected, p_got));
end $$;

-- ── Acting as an API role ────────────────────────────────────────────────────
-- Assertions themselves always run as the superuser; only the statement under
-- test runs as anon / authenticated (SET LOCAL ROLE), and the role is always
-- reset before control returns. That is how PostgREST executes requests.

-- Runs one statement as p_role and keeps its effects. Never raises for the
-- statement's own errors: it reports them.
create function medinv_t.run_as(p_role text, p_sql text,
                                out state text, out affected bigint, out message text)
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics affected = row_count;
    state := '00000';
  exception when others then
    state := sqlstate;
    message := sqlerrm;
    affected := null;
  end;
  reset role;
end $$;

-- Runs one SELECT as p_role and returns its first column of its first row as
-- text (NULL when no rows, 'ERR:<sqlstate>' on error).
create function medinv_t.scalar_as(p_role text, p_sql text) returns text
language plpgsql as $$
declare
  v text;
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    return 'ERR:' || sqlstate;
  end;
  reset role;
  return v;
end $$;

-- Runs one statement as p_role (NULL = stay superuser), reports the outcome,
-- and ALWAYS rolls everything back, even when the statement succeeds.
-- Outcome: 'ok:some' (touched or returned rows), 'ok:none' (ran, 0 rows: what
-- RLS does to a write it does not allow) or 'err:<sqlstate>'.
create function medinv_t.probe(p_role text, p_sql text) returns text
language plpgsql as $$
declare
  v_result text;
  v_rows   bigint;
begin
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    begin
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_result := case when v_rows = 0 then 'ok:none' else 'ok:some' end;
    exception when others then
      v_result := 'err:' || sqlstate;
    end;
    raise exception 'medinv_t.probe rollback' using errcode = 'MT001';
  exception when sqlstate 'MT001' then
    null;   -- the rollback also restores the role
  end;
  return v_result;
end $$;

-- Like probe, but after the action it runs p_verify (as the superuser, one
-- query returning one value) before rolling back. Returns '<outcome> / <value>'.
create function medinv_t.probe_then(p_role text, p_action text, p_verify text) returns text
language plpgsql as $$
declare
  v_action text;
  v_rows   bigint;
  v_verify text;
begin
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    begin
      execute p_action;
      get diagnostics v_rows = row_count;
      v_action := case when v_rows = 0 then 'ok:none' else 'ok:some' end;
    exception when others then
      v_action := 'err:' || sqlstate;
    end;
    reset role;
    execute p_verify into v_verify;
    raise exception 'medinv_t.probe rollback' using errcode = 'MT001';
  exception when sqlstate 'MT001' then
    null;
  end;
  return v_action || ' / ' || coalesce(v_verify, '<null>');
end $$;

-- What a role can actually do, found by trying it (all rolled back).
create function medinv_t.privilege_matrix(p_role text) returns jsonb
language plpgsql as $$
declare
  r record;
  m jsonb := '{}'::jsonb;
begin
  for r in
    select * from (values
      ('medications.select',    'select * from public.medications'),
      ('medications.insert',    $q$insert into public.medications (barcode) values ('PROBE-MED')$q$),
      ('medications.update',    'update public.medications set notes = notes'),
      ('medications.delete',    'delete from public.medications'),
      ('transactions.select',   'select * from public.transactions'),
      ('transactions.insert',   $q$insert into public.transactions (medication_id, type, quantity) select id, 'receive', 1 from public.medications limit 1$q$),
      ('transactions.update',   'update public.transactions set note = note'),
      ('transactions.delete',   'delete from public.transactions'),
      ('categories.select',     'select * from public.categories'),
      ('categories.insert',     $q$insert into public.categories (name) values ('PROBE-CAT')$q$),
      ('categories.update',     'update public.categories set name = name'),
      ('categories.delete',     'delete from public.categories where id not in (select category_id from public.medications where category_id is not null)'),
      ('rpc.record_transaction', $q$select * from public.record_transaction((select min(id) from public.medications), 'receive', 1, 'probe')$q$)
    ) v(k, sql)
  loop
    m := m || jsonb_build_object(r.k, medinv_t.probe(p_role, r.sql));
  end loop;
  return m;
end $$;

-- ── Fingerprints ─────────────────────────────────────────────────────────────

-- One line per structural fact about the public schema: columns (type, nullability,
-- default), constraints, indexes, RLS flags + owner + table privileges, policies,
-- triggers, functions (definition hash, security definer flag, privileges).
create function medinv_t.catalog_lines() returns setof text
language sql stable as $$
  select format('col %s.%s %s notnull=%s default=%s', c.relname, a.attname,
                format_type(a.atttypid, a.atttypmod), a.attnotnull,
                coalesce(pg_get_expr(d.adbin, d.adrelid), '-'))
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
  union all
  select format('con %s.%s %s', c.relname, k.conname, pg_get_constraintdef(k.oid))
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
  union all
  select format('idx %s', pg_get_indexdef(i.indexrelid))
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
  union all
  select format('rel %s rls=%s force=%s owner=%s acl=%s', c.relname, c.relrowsecurity,
                c.relforcerowsecurity, pg_get_userbyid(c.relowner), coalesce(c.relacl::text, '-'))
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
  union all
  select format('pol %s.%I permissive=%s cmd=%s roles=%s using=%s check=%s', p.tablename, p.policyname,
                p.permissive, p.cmd, p.roles::text, coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
    from pg_policies p
   where p.schemaname = 'public'
  union all
  select format('trg %s', pg_get_triggerdef(t.oid))
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
  union all
  select format('fn %s(%s) md5=%s secdef=%s acl=%s', f.proname, pg_get_function_identity_arguments(f.oid),
                md5(pg_get_functiondef(f.oid)), f.prosecdef, coalesce(f.proacl::text, '-'))
    from pg_proc f
   where f.pronamespace = 'public'::regnamespace and f.prokind = 'f'
$$;

-- One hash per table over every row and every ORIGINAL column (the new
-- supplier_order_number column is removed from the row before hashing, so the
-- same function works before and after the migration). Run as the superuser, so
-- RLS never hides a row from it.
create function medinv_t.data_fingerprint() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'medications', md5(coalesce((select string_agg(md5((to_jsonb(m) - 'supplier_order_number')::text), ',' order by m.id) from public.medications m), '')),
    'transactions', md5(coalesce((select string_agg(md5(to_jsonb(t)::text), ',' order by t.id) from public.transactions t), '')),
    'categories',  md5(coalesce((select string_agg(md5(to_jsonb(c)::text), ',' order by c.id) from public.categories c), '')),
    'counts', jsonb_build_object(
      'medications', (select count(*) from public.medications),
      'transactions', (select count(*) from public.transactions),
      'categories', (select count(*) from public.categories)))
$$;

create table medinv_t.snap (
  label       text primary key,
  catalog     text[] not null,
  data        jsonb  not null,
  matrix_anon jsonb  not null,
  matrix_auth jsonb  not null
);

create function medinv_t.save_snapshot(p_label text) returns void
language plpgsql as $$
begin
  insert into medinv_t.snap
  select p_label,
         (select array_agg(l order by l) from medinv_t.catalog_lines() l),
         medinv_t.data_fingerprint(),
         medinv_t.privilege_matrix('anon'),
         medinv_t.privilege_matrix('authenticated');
end $$;

-- Lines present in snapshot p_to but not in p_from, and the reverse.
create function medinv_t.catalog_added(p_from text, p_to text) returns setof text
language sql stable as $$
  select unnest(catalog) from medinv_t.snap where label = p_to
  except
  select unnest(catalog) from medinv_t.snap where label = p_from
$$;

create function medinv_t.catalog_removed(p_from text, p_to text) returns setof text
language sql stable as $$
  select medinv_t.catalog_added(p_to, p_from)
$$;

-- Keys whose probe outcome differs between two matrices, sorted, comma-joined,
-- each as key(old->new).
create function medinv_t.matrix_diff(p_before jsonb, p_after jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(format('%s(%s->%s)', k, p_before->>k, p_after->>k), ', ' order by k), '')
    from jsonb_object_keys(p_after) k
   where p_before->>k is distinct from p_after->>k
$$;

-- What anon may do with categories when row level security is ON for that
-- table: read, create, but not rename and not delete. Callers enable RLS first
-- when the shape does not have it on.
create function medinv_t.assert_categories_least_privilege(p_label text) returns void
language plpgsql as $$
declare
  m jsonb := medinv_t.privilege_matrix('anon');
  n bigint;
begin
  select count(*) into n from public.categories;
  perform medinv_t.eq(p_label || ': anon can read categories', m->>'categories.select', 'ok:some');
  perform medinv_t.eq(p_label || ': anon sees every one of the ' || n || ' categories',
                      medinv_t.scalar_as('anon', 'select count(*) from public.categories'), n::text);
  perform medinv_t.eq(p_label || ': anon can create a category', m->>'categories.insert', 'ok:some');
  perform medinv_t.eq(p_label || ': anon cannot rename a category (0 rows updated, no error)', m->>'categories.update', 'ok:none');
  perform medinv_t.eq(p_label || ': anon cannot delete a category (0 rows deleted, no error)', m->>'categories.delete', 'ok:none');
end $$;
