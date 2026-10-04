-- lovable-cron-fallback-reviewed: queue wake-on-enqueue; job is only scheduled while chapters are pending and unschedules itself after drain
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.novels (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'running',
  total_chapters int not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  notified boolean not null default false
);
grant all on public.novels to service_role;
alter table public.novels enable row level security;

create table public.chapters (
  novel_id uuid not null references public.novels(id) on delete cascade,
  idx int not null,
  title text not null default '',
  source_text text not null,
  translated_title text,
  translated_text text,
  status text not null default 'pending',
  engine text,
  attempts int not null default 0,
  locked_at timestamptz,
  last_error text,
  word_count int not null default 0,
  primary key (novel_id, idx)
);
create index chapters_pending_idx on public.chapters (status, novel_id, idx);
grant all on public.chapters to service_role;
alter table public.chapters enable row level security;

create table public.app_settings (
  id int primary key default 1 check (id = 1),
  passcode_hash text,
  telegram_chat_id text,
  cron_secret text not null default encode(gen_random_bytes(24), 'hex'),
  tick_url text not null default 'https://project--3bf5c2a1-2c6d-4462-b0c8-71fa99e7ff0e-dev.lovable.app/api/public/tick'
);
insert into public.app_settings (id) values (1);
grant all on public.app_settings to service_role;
alter table public.app_settings enable row level security;

create or replace function public.claim_chapters(_limit int)
returns setof public.chapters
language plpgsql security definer set search_path = public
as $$
begin
  return query
  update public.chapters c set status = 'working', locked_at = now(), attempts = c.attempts + 1
  where (c.novel_id, c.idx) in (
    select ch.novel_id, ch.idx from public.chapters ch
    join public.novels n on n.id = ch.novel_id
    where n.status = 'running'
      and (ch.status = 'pending' or (ch.status = 'working' and ch.locked_at < now() - interval '4 minutes'))
    order by n.created_at, ch.idx
    limit _limit
    for update of ch skip locked
  )
  returning c.*;
end $$;

create or replace function public.ensure_tick()
returns void language plpgsql security definer set search_path = public, cron
as $$
declare s record;
begin
  if exists (select 1 from cron.job where jobname = 'megatxt-tick') then return; end if;
  select * into s from public.app_settings where id = 1;
  perform cron.schedule('megatxt-tick', '* * * * *', format(
    $c$select net.http_post(url:=%L, headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',%L), body:='{}'::jsonb, timeout_milliseconds:=60000)$c$,
    s.tick_url, s.cron_secret));
end $$;

create or replace function public.stop_tick()
returns void language plpgsql security definer set search_path = public, cron
as $$
begin
  if exists (select 1 from cron.job where jobname = 'megatxt-tick') then
    perform cron.unschedule('megatxt-tick');
  end if;
end $$;

revoke all on function public.claim_chapters(int), public.ensure_tick(), public.stop_tick() from public, anon, authenticated;
grant execute on function public.claim_chapters(int), public.ensure_tick(), public.stop_tick() to service_role;