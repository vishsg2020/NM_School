# Nalla Malayalam — School Management System

A web app for running the online school: pre-test candidates, assessments, admissions, Advance/Final fees, teacher configuration, class scheduling, class activity and reports. It has three roles: **Manager**, **Sales Team** and **Teacher**.

**How it runs (about ₹750/month, or ₹0 on Netlify's Free plan):**

- **Netlify** serves the web pages and runs the API as one Netlify Function.
- **Supabase (Free plan)** stores the data in Postgres.
- Database changes (migrations) are applied automatically on every production deploy.
- A weekly GitHub Action backs up the database, because Supabase Free has no automatic backups.

---

## 1. Set up Supabase (the database)

1. Create a free account at supabase.com → **New project**.
   - **Region: East US (Ohio).** Netlify runs the API in Ohio on the Free and Personal plans, so this keeps database calls fast.
   - Save the database password somewhere safe.
2. When the project is ready, open **Connect** (top bar) → **Connection string** → **Transaction pooler** (port **6543**). Copy the URI. It looks like:
   `postgresql://postgres.<project-ref>:<password>@aws-0-us-east-2.pooler.supabase.com:6543/postgres`
   Put your password in place of `[YOUR-PASSWORD]`. If the password has symbols like `@ # % /`, percent-encode them, or pick a password with only letters and numbers.
3. *(Recommended)* Turn on verified TLS:
   - In Supabase, open **Project Settings → Database → SSL Configuration** and choose **Download certificate**.
   - Commit the file to the repository as **`db/ca.crt`**. It's a public certificate, not a secret.
   - Without it, the connection is still encrypted, but the server's identity isn't checked.
4. *(Optional)* In **Project Settings → Data API**, turn the Data API off; the app doesn't use it. Even if it stays on, migration `0002` blocks it from reading or changing any table.

You don't need to create tables. The first production deploy runs the migrations.

## 2. Deploy to Netlify

1. **Push this folder to a new private GitHub repository.** Don't commit `data/`, `.env` or any `*.db` file; `.gitignore` excludes them.
2. In Netlify: **Add new project → Import an existing project →** pick the repository. Leave the build settings alone; they come from `netlify.toml`:
   - Production deploys and branch deploys (such as `stage`) run `npm test && npm run migrate`. That's the 14 acceptance tests, then any new database migrations. A failure stops the deploy, so the live site never runs against the wrong database schema.
   - Publish directory `public`; functions in `netlify/functions`.
3. **Before the first deploy**, add these under *Project configuration → Environment variables*:

   | Variable | Value | Scopes |
   |---|---|---|
   | `DATABASE_URL` | the Supabase transaction-pooler URI from step 1.2 | Builds **and** Functions, in every deploy context you use (Production, Branch deploys) |
   | `INITIAL_MANAGER_EMAIL` | the first Manager's email | Functions |
   | `INITIAL_MANAGER_PASSWORD` | a strong temporary password (8+ characters) | Functions |
   | `INITIAL_MANAGER_NAME` | the Manager's name (optional) | Functions |

   - Mark `DATABASE_URL` and `INITIAL_MANAGER_PASSWORD` as **secret**.
   - **Don't set `NODE_ENV=production`.** It makes Netlify skip the packages the test step needs. The app detects Netlify itself and uses HTTPS-only cookies.
4. **Deploy.** If something is misconfigured, the sign-in page shows the reason (for example a missing `DATABASE_URL` or tables not created) instead of an error code. The build log should end with `Applied 0001_init.sql`, `Applied 0002_lock_down_data_api.sql`.
5. Open the site and sign in as the Manager. Change the password (**Change password** in the sidebar). Then **delete `INITIAL_MANAGER_PASSWORD`** from Netlify; it's only used while the database has no users.
6. As the Manager, add teachers (**Teachers**), then logins for teachers and the Sales Team (**Users**).

**Deploy previews share the live database.** Netlify builds a preview for every pull request, and with one `DATABASE_URL` that preview reads and writes real school data. Pick one:
- In *Project configuration → Build & deploy → Deploy Previews*, set previews to **None**.
- Or create a second free Supabase project for testing and give `DATABASE_URL` a different value for the **Deploy Previews** context.

### Netlify plan

- **Personal ($9/month) is recommended.** If credits run out you can top up, instead of the site going offline.
- The **Free** plan (300 credits a month) also covers this app's expected traffic if you deploy only a few times a month (each production deploy costs 15 credits). But Free is a hard limit: if it's used up, Netlify shows "Site not available" until the next month.

### Optional: automatic weekly backup (GitHub Actions)

`.github/workflows/backup.yml` exports every table to JSON every Sunday at 02:00 IST and keeps each copy for 90 days as a private workflow artifact.

To turn it on:
1. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add a secret named `DATABASE_URL` with the same value as in Netlify.
2. To verify it, run the workflow once from the **Actions** tab.

The weekly run also counts as activity, so the free Supabase project is never paused for a week of inactivity, for example over a holiday.

---

## 3. How it fits together

```
Browser ──► Netlify CDN: public/ (index.html, js/, styles.css, fonts/)
        └─► /api/*  ──rewrite──► Netlify Function netlify/functions/api.js (Express app, US East – Ohio)
                                     └─► Supabase Postgres via the transaction pooler (port 6543, TLS)
```

| Path | Purpose |
|---|---|
| `netlify.toml` | Build commands, `/api/*` rewrite, single-page-app fallback, security headers (CSP, HSTS, no-index) |
| `netlify/functions/api.js` | Wraps the Express app with `serverless-http`; opens a small connection pool per request and closes it afterwards |
| `db/migrations/` | Schema files, applied in name order by `npm run migrate`. **Never edit an applied file; add `0003_….sql`.** Applied files are recorded in the `schema_migrations` table. |
| `db/ca.crt` | *(optional)* Supabase root certificate for verified TLS |
| `src/` | The API: `db.js` (Postgres adapter and connection), `migrate.js`, `auth.js`, `audit.js`, `routes/*.js` |
| `public/` | The web app (plain ES modules, self-hosted fonts, no build step) |
| `server.js` | Local server for development (not used on Netlify) |
| `scripts/` | `migrate.js`, `backup.js` (JSON export), `seed-demo.js` (sample data), `bootstrap.js` (first Manager) |
| `.github/workflows/backup.yml` | Weekly backup |
| `test/acceptance.test.js` | 14 API acceptance tests on a real local Postgres |

**Security:**

- Role checks run in the function on every API call.
- Sessions use an httpOnly, Secure, SameSite cookie, and only a hash of the token is stored.
- Sign-in throttling is stored in the database.
- State-changing calls need JSON plus the `X-Requested-With` header (CSRF defence).
- Strict Content-Security-Policy and HSTS; search engines are told not to index the site.
- The database is reached only through TLS.
- Supabase's automatic Data API is blocked by row-level security on every table.

---

## 4. Local development

```bash
npm install
npm start                 # http://localhost:3000 with a local Postgres stored in ./data/pg (nothing to install)
npm test                  # 14 acceptance tests on a fresh in-memory Postgres
npm run seed:demo         # sample data (fictional) in ./data/demo-pg, then:
LOCAL_DB_DIR=./data/demo-pg npm start
#   manager@demo.local / sales1@demo.local / teacher@demo.local — password: demo-password
```

For the first local Manager, put `INITIAL_MANAGER_EMAIL` and `INITIAL_MANAGER_PASSWORD` in `.env` (copy `.env.example`). To run locally against Supabase instead, set `DATABASE_URL` in `.env`.

**Run migrations by hand** (e.g. before the first deploy, or if a deploy's migration step failed):
`DATABASE_URL="<supabase uri>" npm run migrate`

---

## Backups and restore

- **Weekly:** the GitHub Action above. **On demand:** `DATABASE_URL="<supabase uri>" npm run backup` writes a consistent JSON export of every table to `./backups/` and keeps the newest 30.
- Backups contain children's names and parents' phone numbers. Keep them private.
- Supabase's paid Pro plan ($25/month) adds daily backups with point-in-time restore. That's worth it once the school relies on the system every day.
- No restore script is included. Restoring from the JSON export is a manual job.

---

## 5. Roles

| Module | Manager | Sales Team | Teacher |
|---|---|---|---|
| Dashboard | Full, every number linked to its records | Own leads + queue | Own classes and pre-tests |
| Pre-Test Queue | All; add/edit; assign teacher | All candidates; add/edit timing, confirmation, details | Assigned only, no phone numbers |
| Pre-test result | Record/edit; mark reviewed | View | Record/edit own until reviewed |
| Admissions, Payments, Teachers, Reports, Users | Yes | — | — |
| Students | All | — | Own students, no fees |
| Calendar, Class Activity | All | — | Own |

---

## 6. Business rules

- **Candidate entry:**
  - Sales or the Manager enter every candidate by hand; there's no spreadsheet sync.
  - Repeat clicks never create duplicates.
  - The same name *and* phone number gives a warning, but siblings sharing a phone are allowed.
- **Pre-Test Queue filters:** test date, teacher (including Unassigned), status, time confirmation, sales rep and search. They combine, live in the URL, and **Clear filters** restores everything.
- **Assessment:**
  - Keeps the Lead ID and the Assigned Sales Representative.
  - A **Confirmed** result creates the Student, but no enrollment until the Manager completes admission setup.
- **Admission:** creates exactly one enrollment plus the Advance and Final payments, in one transaction. Advance + Final = Total fee is checked **only on Save** and explains the difference.
- **Money:**
  - Total Paid = Paid payments.
  - Outstanding = fee − Paid.
  - Pending = Pending payments.
  - Overdue = Pending with a due date *before* today (IST).
  - Every payment change goes into the audit history with old and new values, the user and the time.
- **Classes:**
  - Completing a class counts once. The class row is locked during the update, so repeated or simultaneous submissions can't double-count.
  - Cancelled or absent classes don't count.
  - 1:1 allows one student per slot; 3:1 allows up to three.
  - Conflicts block a booking; going outside working hours or over capacity only warns.
  - Simultaneous bookings for the same teacher are handled one at a time.

---

## 7. Decisions still to confirm

1. **Capacity** is counted in monthly teaching *sessions*, where a 3:1 group counts once. Going over only warns.
2. **3:1 absentee.** A student marked absent doesn't use up a package class.
3. **Time-confirmation values** are Not Confirmed, Confirmed and Reschedule Requested.
4. **Result editing.** A teacher can edit a result until the Manager marks it reviewed.
5. **Renewals.** A second course after the first one finishes isn't built yet; each student has one Active enrollment.
6. **Enrollment completion.** Enrollments aren't closed automatically when 0 classes remain.
7. **Timezone.** All times are IST.
8. **Fee helper rates.** ₹250 1:1 / ₹350 weekend 1:1 / ₹150 3:1 / +₹50 outside 9 AM–9 PM. The Manager always confirms the total.
9. **Pay.** Reports show pay *inputs* only; pay itself isn't calculated.
10. **Class lengths.** Defaults are 30 min (1:1) and 40 min (3:1), editable per booking.

---

## 8. What was tested before handover

- **Acceptance tests:** all 14 pass on PostgreSQL 17, including the concurrent class-completion test.
- **Migration runner:** applies `0001` and `0002` once, and a second run changes nothing.
- **Data API lock-down:** row-level security is on for all 14 tables. A Supabase-style API role sees 0 rows, while the app's own connection sees all of them.
- **Netlify's bundler:** it packaged the function (1.4 MB) with the optional certificate file. The packaged function ran from an unrelated folder using only `DATABASE_URL`: first Manager created, Secure cookie, Dashboard, Reports, Teachers, Pre-Test Queue, and adding a candidate.
- **Connection settings:** a Supabase URL gets encrypted TLS, which switches to certificate-verified once `db/ca.crt` (or `DATABASE_CA_CERT`) is supplied. A localhost URL gets no TLS.
- **Browser workflow (desktop and phone width):** Sales adds a candidate (one record on double-click) and the queue filters are checked; the Manager assigns a teacher; the teacher records the result; the Manager saves the admission (error only on Save); the Manager schedules a class; completing the class twice counts once.
- **Not tested from here:** a live Supabase project or a live Netlify deploy, since neither account is reachable from this workspace. Do one click-through of the main screens after the first deploy.
