# Angel Sniper — Strike Dashboard PWA + Angel One backend

1. `backend/` -> Render (ya koi bhi Node host). Env: ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET.
2. `pwa/` -> Netlify/Vercel/any https host (ya sirf `Angel-Sniper-single.html` phone me kholo). Settings -> Backend URL.
3. Dash tab: left Call strikes, right Put strikes with LTP. Low/High price filter upar ke box me (ya Settings me).
4. Alarms enable karo (push) — app band hone par notification; beep app khula hone par.

## Supabase call-log sync (optional)
```sql
create table call_log (id bigint generated always as identity primary key, t timestamptz, scope text, index_name text, kind text, side text, strike numeric, opt text, price numeric, rsi numeric, sma numeric, tf text, missed boolean);
alter table call_log enable row level security;
create policy "anon insert" on call_log for insert to anon with check (true);
```
Settings -> Supabase me URL + anon key + sbOn.

## Vercel
`vercel --prod` inside `pwa/` (vercel.json included).
