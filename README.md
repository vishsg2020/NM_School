# Nalla Malayalam — School Management System

A web app for running the online school: pre-test candidates, assessments, admissions, Advance/Final fees, teacher configuration, class scheduling, class activity and reports. It has three roles: **Manager**, **Sales Team** and **Teacher**.

Built from *Nalla Malayalam School Management BA v2*, the roles and flow diagrams, and the web-app development prompt. The `nm-school.html` prototype wasn't supplied, so this is a fresh build.

---

## 1. Quick start

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env          # then set INITIAL_MANAGER_EMAIL and INITIAL_MANAGER_PASSWORD
npm start                     # http://localhost:3000
```

On first start the app creates the first Manager from the two `INITIAL_MANAGER_*` variables. Remove the password from `.env` after that. The Manager then adds teachers (**Teachers**) and logins (**Users**).

**Try it with sample data** (fictional names, kept in a separate file):

```bash
npm run seed:demo
DATABASE_PATH=./data/demo.db npm start
# manager@demo.local / sales1@demo.local / teacher@demo.local — password: demo-password
```

**Run the tests:** `npm test`

---

## 2. Architecture

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + Express 5 | Small, well known, easy to host |
| Database | SQLite (better-sqlite3, WAL mode) | One file, real foreign keys and transactions, simple backups |
| Auth | bcrypt passwords, random session token in an httpOnly SameSite cookie, only the hash stored | No third-party dependency |
| Frontend | Plain ES modules, no build step, self-hosted fonts | Nothing to compile; strict Content-Security-Policy |

```
server.js               entry point (loads .env, opens DB, creates first Manager)
src/db.js               schema + numbered migrations (PRAGMA user_version)
src/auth.js             login, sessions, role middleware, throttling
src/audit.js            audit log helper (old/new values, user, time, reason)
src/routes/*.js         API modules: users, teachers, candidates (+results), admissions (+enrollments,
                        payments, students), classes (+calendar), reports (+dashboard)
public/                 the web app (index.html, styles.css, js/core.js, js/app.js, js/pages/*)
scripts/                backup.js, seed-demo.js, bootstrap.js, load-env.js
test/acceptance.test.js API acceptance tests
```

**Security measures**

- Every API route checks the role on the server, not only in the UI.
- State-changing calls must send JSON with an `X-Requested-With` header, as a CSRF defence.
- Strict CSP with no inline scripts or styles.
- Login is throttled after repeated failures.
- Deactivating a user or teacher ends their sessions immediately.
- Teachers never receive parent phone numbers or fee data.
- Secrets live only in environment variables.

---

## 3. Data model

`users` · `sessions` · `teachers` · `teacher_hours` (working hours) · `teacher_slots` (availability windows) · `candidates` (Lead ID, unique) · `pretest_results` (one per candidate) · `students` (one per candidate, created on a Confirmed result) · `enrollments` · `payments` (unique per enrollment + stage) · `classes` (one row per student per class; a 3:1 group = up to 3 rows sharing teacher and time) · `audit_events`

Key integrity rules enforced in the database:

- Lead ID is unique (case-insensitive).
- Each candidate has one result and at most one student record.
- A student can have only **one Active enrollment** (partial unique index).
- Payment stage is `Advance` or `Final`, with one of each per enrollment.
- `completed_classes ≤ total_classes`.
- Every link is a foreign key, and indexes cover all filter columns.
- The enrollment stores a snapshot of the **Lead ID and Assigned Sales Representative** for attribution.

---

## 4. Roles and module map

| Module (route) | Manager | Sales Team | Teacher |
|---|---|---|---|
| Dashboard `#/dashboard` | Full metrics, each linked to its records | Own leads + queue metrics | Own classes and pre-tests |
| Pre-Test Queue `#/pretests` | All; add/edit; assign teacher | **All candidates** (decision confirmed); add/edit timing, confirmation, details | Assigned only, no phone numbers |
| Pre-Test Result `#/candidate/:id` | Record/edit; mark reviewed | View | Record/edit own until the Manager reviews it |
| Admissions `#/admissions` | Yes | — | — |
| Students `#/students` | All | — | Own students (no fees) |
| Payments `#/payments` | Yes | — | — |
| Calendar `#/calendar` | Any teacher | — | Own |
| Class Activity `#/classes` | All; correct completed classes | — | Own classes |
| Teachers `#/teachers` | Add/edit/deactivate; hours, slots, formats, capacity | — | — |
| Reports `#/reports` | Yes | — | — |
| Users `#/users` | Yes | — | — |

---

## 5. How the business rules are implemented

| Rule | Implementation |
|---|---|
| No spreadsheet sync | There is no import/sync code anywhere. Candidates are entered by hand by Sales or the Manager. |
| Duplicate candidates | Each form has a one-time request key, so a double click returns the same record. The same student name **and** the same phone number triggers a warning, and you can still choose to save. Siblings sharing a phone are allowed. |
| Pre-Test Queue filters | Test date, teacher (including Unassigned), status, time confirmation, sales rep and search. Filters combine with AND, sit in the URL so dashboard links open pre-filtered, and **Clear filters** restores the full list. |
| Assessment | Keeps the Lead ID and sales rep from the candidate. **Confirmed** creates the Student and **no** enrollment. Follow-up sets the candidate to Follow-up; Confirmed and Not Interested set it to Completed. |
| Admission | Creates one enrollment plus exactly two payments (Advance, Final) in a single transaction. Repeat clicks are blocked by the request key and the one-active-enrollment index. |
| Advance + Final = Total | Checked **only on Save**, in the browser and on the server, with a message such as "Advance ₹1,000 + Final ₹1 = ₹1,001, which is ₹1,499 less than the Total Course Fee of ₹2,500". Nothing is flagged while you type. |
| Money totals | Total Paid = sum of Paid payments. Outstanding = fee − Paid. Pending = sum of Pending payments. Overdue = Pending with a due date **before** today (IST); a payment due today is not overdue. |
| Payment edits | Every change is written to the audit history with old and new values, the user and the time. Amounts change only through **Edit fee plan**, which keeps the sum equal to the fee and requires a reason. Moving a payment from Paid back to Pending also requires a reason. |
| Class completion | A `counted` flag is flipped inside the same transaction that changes `completed_classes`, so repeated or simultaneous submissions count once. Cancelled, absent and rescheduled classes don't count. Only the Manager can undo a completion, and that decrements once. A class can't be completed before its date or without Present/Late attendance. |
| Scheduling | **Blocks:** inactive teacher, unsupported format, a 1:1 overlap, a full 3:1 group (3 students), or a student double-booked. **Warns, and you must confirm:** outside working hours, outside availability slots, over monthly capacity, before the start date, or more classes booked than remain. |
| Teacher deactivation | Shows the teacher's active enrollments, upcoming classes and open pre-tests, and asks for confirmation. The teacher can't sign in afterwards. There is no limit on the number of teachers. |

---

## 6. Decisions that need your confirmation

I chose sensible defaults for these. Each is easy to change.

1. **Capacity definition.** Monthly capacity counts *teaching sessions* (one teacher time slot; a 3:1 group with three students is one session). Going over capacity only warns.
2. **3:1 group, absent student.** A student marked absent doesn't use up a class from their package. The group session still counts as conducted for the teacher (the "Completed 3:1 sessions" report input) if at least one student attended.
3. **Time-confirmation values.** These are Not Confirmed, Confirmed and Reschedule Requested. The documents name the field but not its values.
4. **Result locking.** A teacher can edit their result until the Manager marks it reviewed. "Needs Review" stays a status the Manager sets by hand.
5. **Renewals.** One Active enrollment per student. A second course after one finishes (a renewal) isn't built yet. Today it would need the Manager to mark the first enrollment Completed, and the admission screen only lists students with no enrollment.
6. **Enrollment completion.** When remaining classes reach 0, the enrollment is not closed automatically. It shows 0 remaining, and the Manager sets it to Completed.
7. **Timezone.** All times are IST. Families abroad see IST times, and their local time isn't stored.
8. **Fee helper.** The rates come from the fee PDF: 1:1 ₹250, weekend 1:1 ₹350, 3:1 ₹150, +₹50 outside 9 AM–9 PM. Video on Demand and Star Teacher fees are entered by hand. The Manager always confirms the total.
9. **Pay and incentives.** Reports show the *inputs* only: completed 1:1 classes, 3:1 sessions and teacher absences per teacher, and collected payments per sales rep. Pay itself isn't calculated, as agreed.
10. **Default class lengths.** 30 min (1:1) and 40 min (3:1), editable per booking.
11. **Payment methods.** UPI, Bank Transfer, Cash, Card, Other.

---

## 7. Test results

`npm test` runs 14 API acceptance tests, all passing. They cover:

- unauthenticated and cross-site requests are rejected;
- teacher add/edit/deactivate and availability/capacity configuration;
- Manager and Sales add candidates, with idempotent repeat submits and a duplicate warning that allows siblings;
- timing and confirmation updates, with server-side role checks;
- every Pre-Test Queue filter alone and combined, and clearing them;
- the assessment keeps the Lead ID and rep, and creates a student but no enrollment;
- the admission mismatch error appears only on a real mismatch, and one enrollment plus Advance/Final is created with no duplicates;
- Paid/Pending/Overdue totals, including the due-today edge case, plus the payment audit history;
- scheduling conflicts and warnings, the 1:1 limit and the 3:1 limit of three;
- class completion counts once, including concurrent submissions, and a Manager correction undoes it once;
- the Class Activity student filter;
- dashboard and report totals match the underlying records;
- teacher deactivation blocks sign-in.

A browser test (Playwright, desktop and 390 px mobile) also ran the whole journey through the UI:

1. Sales adds a candidate (a double click creates one), and the queue filters work alone and combined.
2. The Manager assigns a teacher.
3. The teacher records the result.
4. The Manager saves the admission: no error while typing, the error only on Save, and the save succeeds after fixing the amounts.
5. The Manager schedules a class.
6. The class is completed twice and the count goes up once.
7. There is no horizontal scrolling on mobile, and there were no page errors.

---

## 8. Deployment

Any host that runs Node and gives you a **persistent disk** works: a small VPS, Render with a disk, Railway with a volume, or Fly.io with a volume.

1. Set the environment variables from `.env.example`:
   - `NODE_ENV=production`
   - `DATABASE_PATH` pointing at the persistent disk
   - `TRUST_PROXY=1` behind a proxy or load balancer
   - the `INITIAL_MANAGER_*` variables for the first start only
2. Serve the app **over HTTPS**. Production cookies are Secure-only, so it won't work over plain HTTP. Hosted platforms provide HTTPS. On a VPS, put Caddy or nginx with Let's Encrypt in front of `localhost:3000`.
3. Keep it running with systemd or pm2 (`pm2 start server.js --name nm-school`).
4. Upgrades: `git pull && npm ci && restart`. Schema migrations run automatically at start-up. Take a backup first.

**Backups**

- `npm run backup` writes a consistent online copy to `BACKUP_DIR`, checks its integrity and keeps the newest `BACKUP_KEEP` copies. It's safe to run while the app is in use.
- Schedule it daily, for example with cron: `15 2 * * * cd /srv/nm-school && npm run backup`.
- Also copy the backup folder off the server (for example with rclone to Google Drive or S3). A backup on the same disk doesn't protect against losing that disk.
- To restore: stop the app, replace the database file with a backup, and start the app.

**Personal data**

The app stores children's names and ages, parents' phone numbers and payment references. Limit Manager accounts, use strong passwords, deactivate accounts when people leave, and keep backups private.
