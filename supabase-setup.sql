-- NETBAND temporary room chat
-- Run this in Supabase Dashboard -> SQL Editor.
-- This is an anonymous, room-code-based prototype, NOT end-to-end encrypted.
-- Anyone who obtains a room code may be able to read/send in that room until expiry.

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id text not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx on public.messages(room_id, created_at);
alter table public.rooms enable row level security;
alter table public.messages enable row level security;

drop policy if exists "rooms_create_anon" on public.rooms;
create policy "rooms_create_anon" on public.rooms for insert to anon
with check (expires_at > now() and expires_at <= now() + interval '31 minutes');

drop policy if exists "rooms_read_active_anon" on public.rooms;
create policy "rooms_read_active_anon" on public.rooms for select to anon
using (expires_at > now());

drop policy if exists "messages_read_active_room_anon" on public.messages;
create policy "messages_read_active_room_anon" on public.messages for select to anon
using (exists (select 1 from public.rooms r where r.id = room_id and r.expires_at > now()));

drop policy if exists "messages_insert_active_room_anon" on public.messages;
create policy "messages_insert_active_room_anon" on public.messages for insert to anon
with check (
  char_length(body) between 1 and 2000
  and exists (select 1 from public.rooms r where r.id = room_id and r.expires_at > now())
);

-- Enable Realtime INSERT events for messages.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- Server-side cleanup: run this function periodically with Supabase Cron.
-- If pg_cron is available, uncomment the cron section below after enabling the extension.
create or replace function public.netband_cleanup_expired_rooms()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rooms where expires_at <= now();
$$;

revoke all on function public.netband_cleanup_expired_rooms() from public, anon, authenticated;

-- Optional: in Supabase Dashboard, enable pg_cron, then run once:
-- select cron.schedule(
--   'netband-cleanup-expired-rooms',
--   '* * * * *',
--   $$select public.netband_cleanup_expired_rooms();$$
-- );
-- The scheduled job deletes expired rooms and their messages (ON DELETE CASCADE).
-- Until this cleanup job is enabled, expired rooms are blocked by policies but their
-- rows may remain in the database. Do not claim deletion is active until Cron is enabled.
