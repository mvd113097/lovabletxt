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
      and (ch.status = 'pending' or (ch.status = 'working' and ch.locked_at < now() - interval '2 minutes'))
      -- Sliding window: never run far ahead of the first unfinished chapter,
      -- so the downloadable "chapters 1..N" keeps pace with progress.
      and ch.idx < (select min(x.idx) from public.chapters x where x.novel_id = ch.novel_id and x.status <> 'done') + _limit + 6
    order by n.created_at, ch.idx
    limit _limit
    for update of ch skip locked
  )
  returning c.*;
end $$;
revoke all on function public.claim_chapters(int) from public, anon, authenticated;
grant execute on function public.claim_chapters(int) to service_role;