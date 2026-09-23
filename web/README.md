# Web app (deploy this folder)

The dashboard (Super Admin / HR) and the Employee Portal, plus the Firebase security rules.

```
web/
├─ public/                  ← the site Firebase Hosting serves (this is what goes online)
│  ├─ index.html, app.js          Dashboard (Super Admin / HR)
│  ├─ employee.html, employee-app.js   Employee Portal (own attendance only)
│  ├─ styles.css, employee-styles.css, logo.png
│  └─ config.js                   generated from .env by `npm run build:config` (git-ignored)
├─ firestore.rules          ← role-based security rules (deployed together with the site)
├─ firebase.json, .firebaserc, firestore.indexes.json
├─ server.mjs, lib/, scripts/     local dev server + config builder
├─ .env.example → .env      ← your Firebase web config (git-ignored)
├─ package.json
└─ tests/                   ← automated tests (never deployed)
```

Only `public/` and the rules are published by `npm run deploy`. Tests, `node_modules` and `.env` stay on your machine.

## 1. Create the Firebase project

1. https://console.firebase.google.com → **Add project**.
2. Add a **Web app** (`</>`) and copy its config (`apiKey`, `authDomain`, `projectId`, `appId` ...).
3. **Authentication → Sign-in method**: enable **Email/Password** *and* **Anonymous**
   (Anonymous is how the card readers sign in without any password).
4. **Firestore Database → Create database** (pick a region near you, e.g. `asia-south1`).

## 2. Set the admin email and password (here, not in the hardware)

1. **Authentication → Users → Add user**: this email + password is your first **Super Admin** login.
2. Copy that user's **User UID**.
3. **Firestore → Start collection** `users`, document ID = that UID, fields:
   ```
   email: "admin@your-company.com"   (string, same as the Auth user)
   name:  "Admin"                    (string)
   role:  "super_admin"              (string)
   ```
Every other login is created from the dashboard's **Users** panel: the Super Admin creates HR logins, and HR creates employee logins. Card readers are approved in **Devices**.

## 3. Configure and run

```bash
cd web
npm install                 # only needed for the tests
cp .env.example .env        # then fill in your Firebase web config
npm start                   # http://localhost:3000
```

`.env`:

```
APP_NAME=TechCADD Attendance
PORT=3000
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=...
FIREBASE_APP_ID=...
FIREBASE_MEASUREMENT_ID=
```

The Firebase web config is a public identifier, not a secret; the real protection is `firestore.rules`.

## 4. Deploy to the server

```bash
npm install -g firebase-tools    # once
firebase login                   # once
cd web
npm run deploy                   # builds public/config.js, then publishes public/ + firestore.rules
```

Your site goes live at `https://<project-id>.web.app`. To publish only a rules change: `firebase deploy --only firestore:rules`.
Any static host (Vercel, Netlify ...) also works: run `npm run build:config`, then publish the `public/` folder.

**Important:** after pulling changes to `firestore.rules`, deploy them - the app and the reader rely on them.

## Roles

| Role | Can do |
|---|---|
| `super_admin` | Everything: employees, attendance, **Users** (logins), **Devices** (approve readers), delete employees, **Edit Time** on any recorded time |
| `hr` | Add / edit employees, assign cards, see attendance, make remarks, and **create / revoke employee logins** (Users panel, employee role only). Cannot delete employees, cannot rewrite a recorded time, cannot create HR / admin logins, no Devices |
| `employee` | Employee Portal: own attendance only; verify location; undo their own not-yet-checked-out day |
| `device` | A **card reader**. Not a person: it is approved from **Devices**, reads a single employee / attendance record by id and writes attendance. Cannot list anything |

## Using the dashboard

- **Add Employee**: type the card UID (see the reader's Serial Monitor when you tap it), ID, name, branch, department, role. A card UID or Employee ID that is already in use is refused.
- **Who makes whom:** the **Super Admin makes HR** (and other Super Admin) logins; **HR makes employee** logins. HR first adds the employee (card) under *Add Employee*, then opens **Users**, picks that employee under *Linked Employee*, and sets an email + temporary password. HR only ever sees and manages employee logins, never HR or admin ones. The database rules enforce this, not just the screens.
- **Users**: create logins as above; **Revoke Access** cuts a login off (HR can revoke employee logins only).
- **Devices** (Super Admin): a reader that is powered on and on WiFi appears as **Pending**. Check its name, click **Approve**. **Revoke** switches it off; **Remove** clears the entry (it reappears as Pending if the reader is still on).
- **Attendance Today / Attendance / Calendar**: history and filters. Super Admin gets **Edit Time**.

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm start` fails | Install Node.js (LTS); check `node -v` |
| Dashboard won't load / "local demo mode" | `.env` is missing or incomplete |
| "Your account is not set up yet" | The Auth user has no `users/{uid}` document (Step 2, or create it in Users) |
| "This login is for staff only" | An employee tried the dashboard - they use `employee.html` |
| Employee: "profile was not found" | The linked employee no longer exists; re-link in Users |
| A reader is not listed in Devices | Anonymous sign-in is off (Step 1.3), or the rules were not deployed, or the reader has no internet |
| Reader taps do nothing | It is still **Pending** or was **Revoked** - approve it in Devices |
| Permission errors after an update | Run `firebase deploy --only firestore:rules` |

## Tests

```bash
npm test          # everything (needs Java 21+ and Chrome); uses local emulators only
npm run test:static
```
