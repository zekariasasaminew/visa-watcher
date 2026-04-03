# visa-watcher

Monitors the **US Embassy Addis Ababa** visa appointment page for dates earlier than **May 23, 2026**, and optionally auto-books the first available slot.

> ⚠️ Runs in **DRY RUN** mode by default — it will **never** submit the reschedule form unless you explicitly set `DRY_RUN=false`.

---

## Prerequisites

- [Node.js 18+](https://nodejs.org/) (includes npm)
- A Gmail account with an [App Password](https://myaccount.google.com/apppasswords) enabled

---

## Setup (Windows)

### 1. Install Node.js
Download and install from https://nodejs.org/. Verify with:
```
node -v
npm -v
```

### 2. Install dependencies
Open a terminal in this folder and run:
```
npm install
npx playwright install chromium
```

### 3. Configure credentials
Copy the example env file and fill it in:
```
copy .env.example .env
```

Open `.env` in Notepad and set:
| Variable | Description |
|---|---|
| `VISA_EMAIL` | Your ais.usvisa-info.com login email |
| `VISA_PASSWORD` | Your portal password |
| `DRY_RUN` | `true` = monitor only, `false` = auto-book |
| `EMAIL_USER` | Gmail address for sending alerts |
| `EMAIL_PASS` | Gmail App Password (not your regular password) |

### 4. Run the watcher
```
npm start
```
or
```
node visa-watcher.js
```

---

## What it does

1. Logs in to the visa portal using your credentials
2. Navigates to your appointment page
3. Selects **Addis Ababa** as the facility
4. Opens the date picker and scans for available dates **before May 23, 2026**
5. If none are found → logs the earliest available date and waits **30 seconds**, then repeats
6. If an early date **is** found:
   - Logs it prominently in the console
   - Sends an **email alert** to `zekariassolomon1122@gmail.com`
   - If `DRY_RUN=false`: books the earliest slot, takes screenshots, sends a booking confirmation email

---

## Screenshots

When `DRY_RUN=false` and a booking is made, two screenshots are saved in the project folder:
- `confirmation_before_submit_[timestamp].png` — form filled, before clicking Submit
- `confirmation_[timestamp].png` — page after successful submission

---

## Stopping the script

Press `Ctrl+C` in the terminal at any time.
