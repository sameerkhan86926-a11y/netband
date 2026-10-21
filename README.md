# NETBAND v1 — Temporary Room Chat

This package upgrades the static NETBAND site with a room-code chat interface and Supabase Realtime support.

## Included
- `index.html`, `style.css`, `app.js`: responsive frontend.
- `supabase-setup.sql`: database tables, anonymous RLS policies, realtime publication and cleanup function.
- `manifest.json`, `sw.js`: installable/offline website shell.
- `README.md`: setup steps.

## Important limitations
- Chat requires internet and a configured Supabase project. Offline caching only keeps the website shell available; it does not send messages between disconnected phones.
- This is an anonymous room-code prototype, not end-to-end encrypted. Anyone who gets a room code may access that room until expiry.
- Room expiration is enforced by database policies. Actual row deletion requires enabling Supabase Cron and scheduling the cleanup function as described below.
- Do not put a Supabase service-role/secret key in the website. Use only the publishable key (or legacy anon key).
- Before public launch, add abuse/rate limiting and stronger room access controls.

## Setup from an iPhone
1. Create a Supabase project at https://supabase.com/.
2. In Supabase, open SQL Editor, create a new query, paste all of `supabase-setup.sql`, and run it.
3. In Project Settings / API (or Connect), copy the Project URL and the publishable key (legacy anon key is also supported). Never use a service-role/secret key.
4. Upload the files in this package to the root of your existing GitHub repository, replacing the same-named files. Add `supabase-setup.sql` and this README too.
5. Commit changes. GitHub Actions should deploy the website as before.
6. Open the live site, expand “Backend setup”, enter the project URL and publishable/anon key, then save.
7. On phone A, create a room. Share the 8-character code with phone B. On phone B, open the same website, enter the code and join.
8. Test sending messages both ways while both phones have internet.

## Enable automatic cleanup
After enabling the `pg_cron` extension in Supabase, open SQL Editor and run:
```sql
select cron.schedule(
  'netband-cleanup-expired-rooms',
  '* * * * *',
  $$select public.netband_cleanup_expired_rooms();$$
);
```
If Cron isn't available in the project, use a trusted scheduled server-side job to invoke cleanup. Do not expose the cleanup function to anonymous clients.

## If realtime does not work
- Verify SQL ran successfully.
- In Supabase Dashboard, ensure `public.messages` is in the `supabase_realtime` publication (the SQL tries to add it).
- Check browser console/logs and the error message in the chat UI.
