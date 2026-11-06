-- Used by supabase/tests/run.sh as the "live" shape. Everything below the
-- divider line is the replica DDL exactly as reconstructed (read-only catalog
-- queries, 2026-11-05) from the deployed Health Center database. It contains
-- NO production rows and is only ever loaded into throwaway local databases
-- named medinv_test_*. It is NOT a schema to deploy; supabase/schema.sql is.
-- ----------------------------------------------------------------------------
-- THROWAWAY LOCAL REPLICA of the Health Center project's public schema,
-- reconstructed from read-only catalog queries on 2026-11-05. DDL only; no production rows.
-- Differences from supabase/schema.sql that matter:
--   * categories.id and medications.category_id are UUID (schema.sql says BIGINT)
--   * categories has RLS enabled and NO policies
--   * medications.category_id FK has no ON DELETE SET NULL
--   * extra keepalive table

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz default now()
);

create table public.medications (
  id          bigserial primary key,
  name        text,
  barcode     text not null unique,
  photo_url   text,
  stock       integer not null default 0,
  threshold   integer not null default 10,
  vendor_url  text,
  unit        text not null default 'units',
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  category_id uuid references public.categories(id),
  is_unnamed  boolean not null default false
);

create table public.transactions (
  id            bigserial primary key,
  medication_id bigint not null references public.medications(id) on delete cascade,
  type          text not null check (type in ('receive','dispense')),
  quantity      integer not null check (quantity > 0),
  note          text,
  created_at    timestamptz not null default now()
);

create table public.keepalive (
  id   integer primary key default 1,
  note text default 'pinged by GitHub Actions to keep this project from pausing'
);

create index idx_medications_barcode  on public.medications (barcode);
create index idx_medications_category on public.medications (category_id);
create index idx_medications_unnamed  on public.medications (is_unnamed) where is_unnamed = true;
create index idx_transactions_created_at    on public.transactions (created_at);
create index idx_transactions_medication_id on public.transactions (medication_id);

create function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_medications_updated_at before update on public.medications
  for each row execute function public.set_updated_at();

-- verbatim from the live database (pg_get_functiondef)
create or replace function public.record_transaction(p_medication_id bigint, p_type text, p_quantity integer, p_note text default null::text)
 returns setof medications
 language plpgsql
 security definer
as $function$
declare
  v_stock integer;
  v_delta integer;
begin
  select stock into v_stock
  from medications
  where id = p_medication_id
  for update;

  if not found then
    raise exception 'Medication not found';
  end if;

  if p_type = 'dispense' and v_stock < p_quantity then
    raise exception 'Insufficient stock. Current stock: %', v_stock;
  end if;

  v_delta := case when p_type = 'receive' then p_quantity else -p_quantity end;

  insert into transactions (medication_id, type, quantity, note)
  values (p_medication_id, p_type, p_quantity, p_note);

  update medications
  set stock = stock + v_delta
  where id = p_medication_id;

  return query
  select * from medications where id = p_medication_id;
end;
$function$;

-- live RLS state: enabled on all four tables, none forced
alter table public.medications  enable row level security;
alter table public.transactions enable row level security;
alter table public.categories   enable row level security;   -- ENABLED WITH NO POLICY (the defect)
alter table public.keepalive    enable row level security;

create policy "anon: delete medications"   on public.medications  for delete to anon using (true);
create policy "anon: insert medications"   on public.medications  for insert to anon with check (true);
create policy "anon: read all medications" on public.medications  for select to anon using (true);
create policy "anon: update medications"   on public.medications  for update to anon using (true) with check (true);
create policy "anon: read all transactions" on public.transactions for select to anon using (true);
create policy "anon can read keepalive"    on public.keepalive    for select to anon using (true);
-- (no policies on public.categories)

grant execute on function public.record_transaction(bigint, text, integer, text) to anon;
