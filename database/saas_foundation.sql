-- Restaurant SaaS multi-tenant foundation
-- Safe, backward-compatible migration.
-- Assumptions:
-- - Supabase auth is the source of truth for user identity.
-- - Existing tables already exist in public schema.
-- - Current app keeps working with app_users and invite_code while the new model is introduced.

begin;

-- --------------------------------------------------------------------
-- Core branch model
-- --------------------------------------------------------------------
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  branch_key text not null,
  name text not null,
  address text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  unique (business_id, branch_key)
);

create index if not exists branches_business_id_idx on public.branches (business_id);

-- --------------------------------------------------------------------
-- Membership and access control
-- --------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'membership_role'
      and n.nspname = 'public'
  ) then
    create type public.membership_role as enum (
      'owner',
      'admin',
      'manager',
      'cashier',
      'kitchen',
      'accountant',
      'super_admin'
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'membership_status'
      and n.nspname = 'public'
  ) then
    create type public.membership_status as enum ('pending', 'active', 'suspended', 'revoked');
  end if;
end $$;

create table if not exists public.business_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  role public.membership_role not null default 'cashier',
  status public.membership_status not null default 'active',
  full_name text,
  invited_by uuid,
  accepted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, business_id)
);

create index if not exists business_members_business_id_idx on public.business_members (business_id);
create index if not exists business_members_user_id_idx on public.business_members (user_id);
create index if not exists business_members_branch_id_idx on public.business_members (branch_id);

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'app_users'
      and indexname = 'app_users_user_business_unique_idx'
  ) then
    execute 'create unique index app_users_user_business_unique_idx on public.app_users (user_id, business_id)';
  end if;
end $$;

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  invited_by uuid references auth.users(id) on delete set null,
  email text,
  phone text,
  role public.membership_role not null default 'cashier',
  token text not null unique,
  status text not null default 'pending',
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists invites_business_id_idx on public.invites (business_id);
create index if not exists invites_token_idx on public.invites (token);

-- --------------------------------------------------------------------
-- Audit and usage tracking
-- --------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists audit_log_business_id_idx on public.audit_log (business_id, created_at desc);
create index if not exists audit_log_user_id_idx on public.audit_log (user_id, created_at desc);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  page_key text,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists usage_events_business_id_idx on public.usage_events (business_id, created_at desc);
create index if not exists usage_events_event_type_idx on public.usage_events (event_type, created_at desc);

-- --------------------------------------------------------------------
-- Branch columns for operational tables
-- --------------------------------------------------------------------
alter table public.restaurant_tables
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.orders
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.pos_sessions
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.labor_shifts
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.expenses
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.stock_movements
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.payments
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.customers
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.suppliers
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

create index if not exists restaurant_tables_branch_id_idx on public.restaurant_tables (branch_id);
create index if not exists orders_branch_id_idx on public.orders (branch_id);
create index if not exists pos_sessions_branch_id_idx on public.pos_sessions (branch_id);
create index if not exists labor_shifts_branch_id_idx on public.labor_shifts (branch_id);
create index if not exists expenses_branch_id_idx on public.expenses (branch_id);
create index if not exists stock_movements_branch_id_idx on public.stock_movements (branch_id);

-- --------------------------------------------------------------------
-- Backward-compatible helper functions
-- --------------------------------------------------------------------
create or replace function public.create_business(
  p_business_name text,
  p_business_type_key text,
  p_full_name text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_type_id uuid;
  v_business_id uuid;
  v_invite_code text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select id into v_type_id
  from public.business_types
  where type_key = p_business_type_key
  limit 1;

  if v_type_id is null then
    raise exception 'Unknown business type: %', p_business_type_key;
  end if;

  v_invite_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.businesses (name, business_type_id, invite_code, is_active)
  values (p_business_name, v_type_id, v_invite_code, true)
  returning id into v_business_id;

  insert into public.business_members (user_id, business_id, role, status, full_name, accepted_at)
  values (v_user_id, v_business_id, 'owner', 'active', p_full_name, now())
  on conflict (user_id, business_id)
  do update set role = excluded.role, status = excluded.status, full_name = excluded.full_name, accepted_at = excluded.accepted_at, updated_at = now();

  insert into public.app_users (user_id, business_id, role, full_name, is_active, created_at)
  values (v_user_id, v_business_id, 'owner', p_full_name, true, now())
  on conflict (user_id, business_id)
  do update set role = excluded.role, full_name = excluded.full_name, is_active = true;

  insert into public.branches (business_id, branch_key, name, is_active)
  values (v_business_id, 'main', 'Main Branch', true)
  on conflict (business_id, branch_key) do nothing;

  return v_invite_code;
end;
$$;

create or replace function public.redeem_invite_code(
  p_invite_code text,
  p_full_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_business record;
  v_branch_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select b.id as business_id, b.business_type_id
    into v_business
  from public.businesses b
  where b.invite_code = p_invite_code
  limit 1;

  if v_business.business_id is null then
    raise exception 'Invalid invite code';
  end if;

  select id into v_branch_id
  from public.branches
  where business_id = v_business.business_id
  order by created_at asc
  limit 1;

  if v_branch_id is null then
    insert into public.branches (business_id, branch_key, name, is_active)
    values (v_business.business_id, 'main', 'Main Branch', true)
    returning id into v_branch_id;
  end if;

  insert into public.business_members (user_id, business_id, branch_id, role, status, full_name, accepted_at)
  values (v_user_id, v_business.business_id, v_branch_id, 'cashier', 'active', p_full_name, now())
  on conflict (user_id, business_id)
  do update set status = 'active', full_name = excluded.full_name, accepted_at = now(), updated_at = now();

  insert into public.app_users (user_id, business_id, role, full_name, is_active, created_at)
  values (v_user_id, v_business.business_id, 'cashier', p_full_name, true, now())
  on conflict (user_id, business_id)
  do update set role = excluded.role, full_name = excluded.full_name, is_active = true;

  update public.invites
  set status = 'accepted', accepted_at = now()
  where token = p_invite_code;
end;
$$;

commit;
