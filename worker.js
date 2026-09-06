import puppeteer from "puppeteer";
import axios from "axios";
import "dotenv/config";
import fs from "fs";

// ---------------------------------------------------------------------------
// Usage: node worker.js <batchId>
//   batchId: 1, 2, 3, or 4 (each batch covers 10 groups)
//     batch 1 -> groups 1-10   (FACEBOOK_GROUP1..10,  USER_DATA_DIR_1, seen-posts-1.json)
//     batch 2 -> groups 11-20  (FACEBOOK_GROUP11..20, USER_DATA_DIR_2, seen-posts-2.json)
//     etc.
// ---------------------------------------------------------------------------

const batchId = parseInt(process.argv[2], 10);

if (!batchId || batchId < 1) {
  console.error("Usage: node worker.js <batchId>  (e.g. node worker.js 1)");
  process.exit(1);
}

const GROUPS_PER_BATCH = 10;
const offset = (batchId - 1) * GROUPS_PER_BATCH;
const firstGroupNumber = offset + 1;
const lastGroupNumber = offset + GROUPS_PER_BATCH;

const token = process.env.BOT_TOKEN;
const chatId1 = process.env.CHAT_ID1;
const chatId2 = process.env.CHAT_ID2;

const groupUrls = Array.from({ length: GROUPS_PER_BATCH }, (_, i) => {
  const groupNumber = offset + i + 1;
  return process.env[`FACEBOOK_GROUP${groupNumber}`];
});

const executablePathFirefox = process.env.EXECUTABLE_PATH_FIREFOX;
const userDataDir = process.env[`USER_DATA_DIR_${batchId}`];
const SEEN_POSTS_FILE = `seen-posts-${batchId}.json`;

const CHECK_INTERVAL = 30000;
const RENDER_WAIT = 5000;
const NAVIGATION_TIMEOUT = 60000;
const BATCH_SIZE = 5; // how many pages to reload concurrently at once
const MAX_CONSECUTIVE_FAILURES = 3; // recreate a page after this many failed reload/goto attempts

// Sanity check: warn (but don't crash) if any expected env var is missing
groupUrls.forEach((url, i) => {
  if (!url) {
    console.warn(
      `Warning: FACEBOOK_GROUP${offset + i + 1} is not set in the environment.`,
    );
  }
});

// ---------------------------------------------------------------------------
// Known-posts persistence
// ---------------------------------------------------------------------------

function loadKnownPosts() {
  if (!fs.existsSync(SEEN_POSTS_FILE)) {
    return new Set();
  }

  try {
    const data = fs.readFileSync(SEEN_POSTS_FILE, "utf-8");
    return new Set(JSON.parse(data));
  } catch (error) {
    console.error(`Error reading ${SEEN_POSTS_FILE}:`, error.message);
    return new Set();
  }
}

function saveKnownPosts(knownPosts) {
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify([...knownPosts], null, 2));
}

function getPostId(url) {
  const match = url.match(/\/posts\/(\d+)/);
  return match ? match[1] : null;
}

function cleanPostUrl(url) {
  const match = url.match(
    /(https:\/\/www\.facebook\.com\/groups\/\d+\/posts\/\d+)/,
  );

  return match ? match[1] : url;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegramMessage(text) {
  for (const chatId of [chatId1, chatId2]) {
    if (!chatId) continue;

    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
      });

      console.log(`Telegram message sent to ${chatId}!`);
    } catch (error) {
      console.error("Telegram error:", error.response?.data || error.message);
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Page lifecycle, with basic failure tracking + recreation
// ---------------------------------------------------------------------------

// Tracks consecutive failures per page index so we know when to recreate one.
const failureCounts = new Array(GROUPS_PER_BATCH).fill(0);

async function openGroup(page, groupUrl, groupNumber) {
  try {
    console.log(`Opening Group ${groupNumber}: ${groupUrl}`);

    await page.goto(groupUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT));

    console.log(`Group ${groupNumber} loaded successfully`);
  } catch (error) {
    console.error(`Error opening Group ${groupNumber}:`, error.message);
    throw error;
  }
}

async function reloadPage(page, groupNumber, index) {
  try {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT));

    console.log(`Group ${groupNumber} refreshed`);
    failureCounts[index] = 0;
  } catch (error) {
    failureCounts[index] += 1;
    console.error(
      `Error refreshing Group ${groupNumber} (failure ${failureCounts[index]}/${MAX_CONSECUTIVE_FAILURES}):`,
      error.message,
    );
  }
}

// If a page has failed too many times in a row, close it and open a fresh one
// pointed at the same group URL. This recovers from a hung/broken tab (e.g.
// after a Facebook checkpoint or a lost connection) instead of looping
// forever against a dead page.
async function recoverStalePages(browser, pages, groupUrls) {
  for (let i = 0; i < pages.length; i++) {
    if (failureCounts[i] >= MAX_CONSECUTIVE_FAILURES) {
      const groupNumber = offset + i + 1;
      console.warn(
        `Group ${groupNumber} failed ${failureCounts[i]} times in a row. Recreating its page...`,
      );

      try {
        await pages[i].close();
      } catch (closeError) {
        console.error(
          `Error closing stale page for Group ${groupNumber}:`,
          closeError.message,
        );
      }

      const newPage = await browser.newPage();
      newPage.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
      pages[i] = newPage;
      failureCounts[i] = 0;

      await openGroup(newPage, groupUrls[i], groupNumber).catch((error) => {
        console.error(
          `Retry-open still failing for Group ${groupNumber}:`,
          error.message,
        );
      });
    }
  }
}

async function reloadAllGroups(pages) {
  for (let start = 0; start < pages.length; start += BATCH_SIZE) {
    const batch = pages.slice(start, start + BATCH_SIZE);

    const firstInSubBatch = offset + start + 1;
    const lastInSubBatch = Math.min(
      offset + start + BATCH_SIZE,
      offset + GROUPS_PER_BATCH,
    );

    console.log(
      `\nRefreshing Groups ${firstInSubBatch} → ${lastInSubBatch}...`,
    );

    await Promise.all(
      batch.map((page, i) =>
        reloadPage(page, offset + start + i + 1, start + i),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function getPostUrlsFromPage(page) {
  try {
    return await page.$$eval('a[href*="/groups/"][href*="/posts/"]', (links) =>
      links.map((link) => link.href).filter(Boolean),
    );
  } catch (error) {
    console.error("Error getting posts:", error.message);
    return [];
  }
}

async function getPostUrls(pages) {
  const allUrls = [];

  for (let i = 0; i < pages.length; i++) {
    const urls = await getPostUrlsFromPage(pages[i]);
    const groupNumber = offset + i + 1;

    if (urls.length === 0) {
      console.warn(
        `Group ${groupNumber}: 0 post links found — could be genuinely quiet, or the selector/page may be broken. Worth a manual check if this persists.`,
      );
    } else {
      console.log(`Group ${groupNumber}: Found ${urls.length} post links`);
    }

    allUrls.push(...urls);
  }

  return allUrls;
}

// ---------------------------------------------------------------------------
// Main check loop
// ---------------------------------------------------------------------------

async function checkForNewPosts(browser, pages, knownPosts) {
  console.log(
    `\n========== Checking Groups ${firstGroupNumber} → ${lastGroupNumber} ==========`,
  );

  await reloadAllGroups(pages);
  await recoverStalePages(browser, pages, groupUrls);

  const rawUrls = await getPostUrls(pages);
  const uniqueUrls = [...new Set(rawUrls.map(cleanPostUrl).filter(Boolean))];

  console.log(`Total unique posts found: ${uniqueUrls.length}`);

  for (const url of uniqueUrls) {
    const postId = getPostId(url);

    if (!postId || knownPosts.has(postId)) {
      continue;
    }

    console.log(`\nNEW POST FOUND: ${url}`);

    if (await sendTelegramMessage(url)) {
      knownPosts.add(postId);
      saveKnownPosts(knownPosts);
      console.log(`Post ${postId} saved as known`);
    }
  }

  console.log(`Known posts: ${knownPosts.size}`);
}

async function startMonitoring() {
  const knownPosts = loadKnownPosts();
  console.log(`[Batch ${batchId}] Loaded ${knownPosts.size} known posts`);

  const browser = await puppeteer.launch({
    headless: true,
    browser: "firefox",
    executablePath: executablePathFirefox,
    userDataDir,
  });

  let pages = [];

  for (let i = 0; i < groupUrls.length; i++) {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    pages.push(page);
  }

  for (let i = 0; i < pages.length; i++) {
    await openGroup(pages[i], groupUrls[i], offset + i + 1).catch((error) => {
      console.error(
        `Initial open failed for Group ${offset + i + 1}:`,
        error.message,
      );
    });
  }

  console.log("\nCollecting initial posts...");

  const initialUrls = await getPostUrls(pages);

  for (const url of initialUrls) {
    const postId = getPostId(cleanPostUrl(url));
    if (postId) knownPosts.add(postId);
  }

  saveKnownPosts(knownPosts);
  console.log(`Initial posts saved: ${knownPosts.size}`);

  while (true) {
    await checkForNewPosts(browser, pages, knownPosts);

    console.log(
      `\nWaiting ${CHECK_INTERVAL / 1000} seconds before next check...`,
    );

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
  }
}

startMonitoring().catch((error) => {
  console.error(`[Batch ${batchId}] Fatal error:`, error);
  process.exit(1);
});
