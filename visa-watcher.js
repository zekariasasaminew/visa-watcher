"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  loginUrl: "https://ais.usvisa-info.com/en-et/niv/users/sign_in",
  groupUrl: "https://ais.usvisa-info.com/en-et/niv/groups/35339554",
  appointmentUrl:
    "https://ais.usvisa-info.com/en-et/niv/schedule/73600576/appointment",
  facilityValue: "19", // Addis Ababa
  targetBefore: new Date("2026-05-23"), // Graduation — we want anything earlier
  pollIntervalMs: 5 * 60_000, // 5 minutes
  alertRecipient: "zekariassolomon1122@gmail.com",
  dryRun: process.env.DRY_RUN !== "false", // true by default
  singleRun: process.env.SINGLE_RUN === "true", // set by GitHub Actions
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

// ── Email helper ──────────────────────────────────────────────────────────────

function createMailer() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn(
      "[WARN] EMAIL_USER / EMAIL_PASS not set — email alerts disabled.",
    );
    return null;
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

async function sendMail(mailer, { subject, text }) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: process.env.EMAIL_USER,
      to: CONFIG.alertRecipient,
      subject,
      text,
    });
    console.log(`[EMAIL] Sent: "${subject}"`);
  } catch (err) {
    console.error("[EMAIL] Failed to send:", err.message);
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function formatDate(d) {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login(page) {
  console.log("[AUTH] Navigating to login page…");
  await page.goto(CONFIG.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  await page.fill("#user_email", process.env.VISA_EMAIL, { timeout: 15_000 });
  await page.fill("#user_password", process.env.VISA_PASSWORD, {
    timeout: 15_000,
  });

  // The privacy checkbox is wrapped by iCheck which intercepts pointer events.
  // Click the iCheck wrapper div instead; fall back to a forced JS click.
  const isChecked = await page.evaluate(
    () => !!document.querySelector("#policy_confirmed")?.checked,
  );
  if (!isChecked) {
    try {
      // iCheck renders a sibling/parent div with class "icheckbox" — click it
      await page.locator(".icheckbox").first().click({ timeout: 8_000 });
    } catch {
      // Fallback: dispatch a raw click directly on the hidden input via JS
      await page.evaluate(() =>
        document.querySelector("#policy_confirmed").click(),
      );
    }
  }

  await page.click('input[type="submit"][value="Sign In"]', {
    timeout: 10_000,
  });
  await page.waitForNavigation({ timeout: 30_000 });

  if (page.url().includes("sign_in")) {
    throw new Error(
      "[AUTH] Login failed — still on sign_in page. Check credentials.",
    );
  }
  console.log("[AUTH] Logged in successfully. Current URL:", page.url());
}

async function ensureLoggedIn(page) {
  if (page.url().includes("sign_in")) {
    console.log("[AUTH] Session expired — re-logging in…");
    await login(page);
  }
}

// ── Scan calendar for available dates ─────────────────────────────────────────

/**
 * Scans the jQuery UI Datepicker month by month (clicking Next) until it finds
 * at least one selectable date, then returns all dates from that month.
 * This is needed because the calendar opens on the current month (April) which
 * may have zero available slots — the first open date could be months away.
 */
async function getAvailableDates(page) {
  const maxMonthsToScan = 18;

  for (let i = 0; i < maxMonthsToScan; i++) {
    const cells = await page.$$(
      'td[data-handler="selectDay"]:not(.ui-state-disabled)',
    );

    const dates = [];
    for (const cell of cells) {
      const month = await cell.getAttribute("data-month"); // 0-based
      const year = await cell.getAttribute("data-year");
      const day = await cell
        .$eval("a", (a) => a.textContent.trim())
        .catch(() => null);
      if (month === null || year === null || day === null) continue;
      dates.push(new Date(Number(year), Number(month), Number(day)));
    }

    if (dates.length > 0) return dates; // found available dates — stop scanning

    // Nothing this month — advance to next month via JS click (overlay intercepts pointer events)
    const advanced = await page.evaluate(() => {
      const btn = document.querySelector(".ui-datepicker-next");
      if (!btn || btn.classList.contains("ui-state-disabled")) return false;
      btn.click();
      return true;
    });
    if (!advanced) break;
  }

  return []; // no dates found across all scanned months
}

// ── Navigate calendar to target month and click a date ────────────────────────

async function navigateAndClick(page, targetDate) {
  const targetMonth = targetDate.getMonth(); // 0-based
  const targetYear = targetDate.getFullYear();

  // Keep clicking "Next" until the target month/year is visible
  for (let attempts = 0; attempts < 24; attempts++) {
    const visible = await page.$$(
      `td[data-handler="selectDay"][data-month="${targetMonth}"][data-year="${targetYear}"]:not(.ui-state-disabled)`,
    );
    if (visible.length > 0) break;

    const nextBtn = page.locator(".ui-datepicker-next");
    if (!(await nextBtn.isVisible())) break;
    // Use JS click — overlay elements intercept Playwright pointer events
    await page.evaluate(() =>
      document.querySelector(".ui-datepicker-next").click(),
    );
    await page.waitForTimeout(150);
  }

  // Click the specific day
  const targetDay = targetDate.getDate();
  const cell = page
    .locator(
      `td[data-handler="selectDay"][data-month="${targetMonth}"][data-year="${targetYear}"]:not(.ui-state-disabled)`,
    )
    .filter({ hasText: String(targetDay) })
    .first();

  await cell.click({ timeout: 10_000 });
  console.log(`[BOOK] Clicked date: ${formatDate(targetDate)}`);
}

// ── Book the appointment ───────────────────────────────────────────────────────

async function bookAppointment(page, targetDate, mailer) {
  console.log("\n🔔 [BOOK] Starting booking flow…");

  // Open calendar
  await page.click("#appointments_consulate_appointment_date", {
    timeout: 10_000,
  });
  await page.waitForSelector(".ui-datepicker:visible", { timeout: 15_000 });

  await navigateAndClick(page, targetDate);

  // Wait for time dropdown to populate
  console.log("[BOOK] Waiting for time slots…");
  await page.waitForFunction(
    () => {
      const sel = document.querySelector(
        "#appointments_consulate_appointment_time",
      );
      return sel && sel.options.length > 1;
    },
    { timeout: 20_000 },
  );

  // Select first non-empty time
  const timeOptions = await page.$$(
    "#appointments_consulate_appointment_time option",
  );
  let selectedTime = null;
  for (const opt of timeOptions) {
    const val = await opt.getAttribute("value");
    if (val && val.trim() !== "") {
      selectedTime = await opt.textContent();
      await page.selectOption("#appointments_consulate_appointment_time", val);
      break;
    }
  }
  console.log("[BOOK] Time selected:", selectedTime?.trim());

  // Wait for submit button to become enabled
  await page.waitForFunction(
    () => {
      const btn = document.querySelector("#appointments_submit");
      return btn && !btn.disabled;
    },
    { timeout: 20_000 },
  );

  // Screenshot before submit
  const ts = Date.now();
  const screenshotBefore = `confirmation_before_submit_${ts}.png`;
  await page.screenshot({ path: screenshotBefore, fullPage: false });
  console.log("[BOOK] Screenshot saved:", screenshotBefore);

  // Accept the confirm dialog automatically
  page.once("dialog", (dialog) => {
    console.log("[BOOK] Confirm dialog:", dialog.message());
    dialog.accept();
  });

  await page.click("#appointments_submit", { timeout: 10_000 });
  await page.waitForNavigation({ timeout: 30_000 });

  const screenshotAfter = `confirmation_${ts}.png`;
  await page.screenshot({ path: screenshotAfter, fullPage: true });
  console.log("[BOOK] Booking complete! Screenshot saved:", screenshotAfter);

  await sendMail(mailer, {
    subject: `Dad's Visa BOOKED! ${formatDate(targetDate)}`,
    text: [
      `✅ Appointment successfully rescheduled!`,
      ``,
      `New date : ${formatDate(targetDate)}`,
      `Time     : ${selectedTime?.trim() ?? "Unknown"}`,
      ``,
      `Manage your appointment: ${CONFIG.groupUrl}`,
      ``,
      `Screenshots saved locally:`,
      `  • ${screenshotBefore}`,
      `  • ${screenshotAfter}`,
    ].join("\n"),
  });
}

// ── Main poll cycle ───────────────────────────────────────────────────────────

async function pollOnce(page, mailer) {
  await ensureLoggedIn(page);

  console.log("\n[POLL] Navigating to appointment page…");
  await page.goto(CONFIG.appointmentUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  await ensureLoggedIn(page);

  // Select Addis Ababa facility
  console.log("[POLL] Selecting facility: Addis Ababa…");
  await page.selectOption(
    "#appointments_consulate_appointment_facility_id",
    CONFIG.facilityValue,
    { timeout: 15_000 },
  );

  // Wait for the date/time section to appear
  await page.waitForSelector("#consulate_date_time", {
    state: "visible",
    timeout: 20_000,
  });

  // Open the date picker
  await page.click("#appointments_consulate_appointment_date", {
    timeout: 10_000,
  });
  await page.waitForSelector(".ui-datepicker", {
    state: "visible",
    timeout: 15_000,
  });

  // Scan available dates
  const available = await getAvailableDates(page);
  available.sort((a, b) => a - b);

  const earlyDates = available.filter((d) => d < CONFIG.targetBefore);
  const earliest = available[0] ?? null;

  // ── Peek at time slots for the earliest available date ──────────────────────
  // Click it so the time dropdown populates, then read the options without booking.
  const peekedTimes = [];
  if (earliest) {
    try {
      await navigateAndClick(page, earliest);
      await page.waitForFunction(
        () => {
          const sel = document.querySelector(
            "#appointments_consulate_appointment_time",
          );
          return sel && sel.options.length > 1;
        },
        { timeout: 12_000 },
      );
      const timeOpts = await page.$$(
        "#appointments_consulate_appointment_time option",
      );
      for (const opt of timeOpts) {
        const val = await opt.getAttribute("value");
        const text = (await opt.textContent()).trim();
        if (val && val.trim()) peekedTimes.push(text);
      }
    } catch {
      // Non-fatal — time slots just won't be shown this poll
    }
  }

  const timesLabel = peekedTimes.length ? peekedTimes.join(", ") : "N/A";
  const earliestLabel = earliest ? formatDate(earliest) : "None visible";

  if (earlyDates.length === 0) {
    console.log(
      `[POLL] No early dates found.\n` +
        `       Earliest available : ${earliestLabel}\n` +
        `       Available times    : ${timesLabel}\n` +
        `       Waiting ${CONFIG.pollIntervalMs / 1000}s…`,
    );
    return false;
  }

  // ── Early dates found! ──────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  🎉  EARLY VISA DATE(S) AVAILABLE!                  ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  earlyDates.forEach((d) => console.log("   ✅", formatDate(d)));
  console.log(`\n   Earliest available times : ${timesLabel}`);
  console.log(`   DRY_RUN = ${CONFIG.dryRun}`);

  const emailBody = [
    `The following dates are available BEFORE May 23, 2026:\n`,
    ...earlyDates.map((d) => `  • ${formatDate(d)}`),
    ``,
    `Available time slots (for earliest date): ${timesLabel}`,
    ``,
    `DRY_RUN is currently: ${CONFIG.dryRun ? "ON (no booking made)" : "OFF — booking in progress!"}`,
    ``,
    `Appointment page: ${CONFIG.appointmentUrl}`,
  ].join("\n");

  await sendMail(mailer, {
    subject: `Dad's Visa: Early date available – ${formatDate(earlyDates[0])}`,
    text: emailBody,
  });

  if (CONFIG.dryRun) {
    console.log(
      "\n[DRY RUN] Booking skipped. Set DRY_RUN=false in .env to enable auto-booking.",
    );
    return false; // keep polling
  }

  // Proceed with booking
  await bookAppointment(page, earlyDates[0], mailer);
  return true; // signal to exit the loop
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  console.log("════════════════════════════════════════════════════════");
  console.log("  US Embassy Addis Ababa — Visa Appointment Watcher");
  console.log(`  Target: any date before ${formatDate(CONFIG.targetBefore)}`);
  console.log(
    `  Mode:   ${CONFIG.dryRun ? "🟡 DRY RUN (monitor only)" : "🔴 LIVE (will auto-book!)"}`,
  );
  console.log("════════════════════════════════════════════════════════\n");

  if (!process.env.VISA_EMAIL || !process.env.VISA_PASSWORD) {
    console.error("[ERROR] VISA_EMAIL and VISA_PASSWORD must be set in .env");
    process.exit(1);
  }

  const mailer = createMailer();

  async function launchBrowser() {
    const browser = await chromium.launch({
      headless: process.env.SINGLE_RUN === "true" || process.env.CI === "true",
      slowMo: 0,
    });
    const context = await browser.newContext({
      userAgent: CONFIG.userAgent,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    return { browser, page };
  }

  let { browser, page } = await launchBrowser();

  // Helper: wait out a block then launch a fresh browser + login, retrying until it works
  async function recoverWithRetry(reason) {
    let waitMs = 60_000;
    while (true) {
      console.log(`[RECOVERY] ${reason} — waiting ${waitMs / 1000}s before retry...`);
      try { await browser.close(); } catch {}
      await new Promise((r) => setTimeout(r, waitMs));
      try {
        ({ browser, page } = await launchBrowser());
        await login(page);
        console.log('[RECOVERY] Back online.');
        return;
      } catch (retryErr) {
        console.error('[RECOVERY] Still blocked:', retryErr.message);
        waitMs = Math.min(waitMs * 2, 10 * 60_000); // back off up to 10 min
      }
    }
  }

  await login(page).catch(async (e) => {
    console.error('[AUTH] Initial login failed:', e.message);
    await recoverWithRetry('Initial login blocked');
  });

  let pollCount = 0;
  while (true) {
    try {
      const done = await pollOnce(page, mailer);
      if (done || CONFIG.singleRun) break;  // exit after one check in CI
      pollCount++;
      if (pollCount % 9999 === 0) {
        await browser.close();
        ({ browser, page } = await launchBrowser());
        await login(page);
      }
    } catch (pollErr) {
      console.error('[POLL ERROR]', pollErr.message);
      const isNetworkBlock =
        pollErr.message.includes('CONNECTION_REFUSED') ||
        pollErr.message.includes('NETWORK_CHANGED');
      const isBrowserDead =
        pollErr.message.includes('closed') ||
        pollErr.message.includes('EMPTY_RESPONSE') ||
        pollErr.message.includes('ABORTED');
      if (isNetworkBlock || isBrowserDead) {
        await recoverWithRetry(isNetworkBlock ? 'IP blocked' : 'Browser died');
        pollCount = 0;
        continue;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollIntervalMs));
  }

  await browser.close();
  console.log('[EXIT] Done.');
})();
