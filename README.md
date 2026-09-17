# NFL Quant — Vercel Edition
Production-oriented rewrite of the Streamlit MVP.

## Stack
- Next.js + TypeScript on Vercel
- Supabase Auth + Postgres
- GitHub Actions + Python for the weekly model
- ESPN data/logos/odds

## Deploy
1. Create/connect Supabase and run `supabase/schema.sql` in its SQL editor.
2. Copy `.env.example` values into Vercel environment variables. Set `ADMIN_EMAILS` to the email(s) allowed into `/admin`.
3. Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to GitHub Actions secrets.
4. Push this repo to GitHub and import it into Vercel. Vercel detects Next.js automatically.
5. In Supabase Auth URL settings, set the production Site URL to your Vercel/custom domain.

## Local
`npm install && npm run dev`

## Notes
The UI uses ESPN logo URLs saved in each game snapshot. The Python engine remains intentionally separate from Vercel and runs in GitHub Actions. The current numerical engine is the existing market-anchored 50K Monte Carlo baseline; it is ready to be replaced by the full historical feature-trained model without changing the web app.
