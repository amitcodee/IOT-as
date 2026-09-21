# TechCADD RFID Attendance

Employees tap an RFID card on an ESP32 reader; check-in / check-out is stored in Firebase and shown in a web dashboard.

```
IOT-as/
├─ web/         ← the WEB app. This is the only thing you deploy to the server.
└─ hardware/    ← the ESP32 firmware. You flash this onto the chip. It is never deployed.
```

```
 ESP32 + RC522 ──WiFi──►  Firebase (Auth + Firestore)  ◄── Dashboard / Employee Portal (web/)
   (hardware/)              approves the reader,            Super Admin · HR · Employee
   only WiFi info           stores attendance
```

## Where each setting lives

| What | Where | Committed to git? |
|---|---|---|
| Admin / HR / employee **email + password** | Firebase Console (first Super Admin) and the dashboard's **Users** panel | No - never in a file |
| Firebase web config | `web/.env` | No (`.gitignore`) |
| WiFi name + password, Firebase project id, reader name | `hardware/rfid_wifi/secrets.h` | No (`.gitignore`); template: `secrets.h.example` |
| Permission for a reader to write attendance | Approved by a Super Admin in the dashboard's **Devices** panel | It lives in the database |

The chip holds **no Firebase email or password**. It signs in anonymously, shows up in the dashboard as *Pending*, and a Super Admin clicks **Approve** (and can **Revoke** at any time).

## Quick start

1. **Web** - create the Firebase project, set the first Super Admin, run and deploy the site: [`web/README.md`](web/README.md)
2. **Hardware** - wire the RC522, fill in `secrets.h`, flash the ESP32: [`hardware/README.md`](hardware/README.md)
3. **Approve the reader** - power the ESP32 on, open **Devices** in the dashboard, click **Approve**.
4. **Add employees** and tap a card.

## Tests

```bash
cd web
npm install
npm test        # needs Java 21+ and Chrome; boots local Firebase emulators, never touches your real project
```
