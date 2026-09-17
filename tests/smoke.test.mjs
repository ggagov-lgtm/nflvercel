import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('required Vercel app files exist',()=>{for(const f of ['app/page.tsx','app/admin/page.tsx','supabase/schema.sql','python/weekly_run.py','.github/workflows/weekly_model.yml'])assert.ok(fs.existsSync(f),f)});
test('Streamlit removed',()=>{assert.equal(fs.existsSync('app.py'),false)});
