import puppeteer from "puppeteer";
import axios from "axios";
import "dotenv/config";
import fs from "fs";

const token = process.env.BOT_TOKEN;
const chatId1 = process.env.CHAT_ID1;
const chatId2 = process.env.CHAT_ID2;

const groupUrls = [
  process.env.FACEBOOK_GROUP31,
  process.env.FACEBOOK_GROUP32,
  process.env.FACEBOOK_GROUP33,
  process.env.FACEBOOK_GROUP34,
  process.env.FACEBOOK_GROUP35,
  process.env.FACEBOOK_GROUP36,
  process.env.FACEBOOK_GROUP37,
  process.env.FACEBOOK_GROUP38,
  process.env.FACEBOOK_GROUP39,
  process.env.FACEBOOK_GROUP40,
];

const CHECK_INTERVAL = 30000;
const RENDER_WAIT = 5000;
const NAVIGATION_TIMEOUT = 60000;
const BATCH_SIZE = 5;

const SEEN_POSTS_FILE = "seen-posts-4.json";

function loadKnownPosts() {
  if (!fs.existsSync(SEEN_POSTS_FILE)) {
    return new Set();
  }

  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_POSTS_FILE, "utf-8")));
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
  }
}

async function reloadPage(page, groupNumber) {
  try {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT));

    console.log(`Group ${groupNumber} refreshed`);
  } catch (error) {
    console.error(`Error refreshing Group ${groupNumber}:`, error.message);
  }
}

async function reloadAllGroups(pages) {
  for (let start = 0; start < pages.length; start += BATCH_SIZE) {
    const batch = pages.slice(start, start + BATCH_SIZE);

    const firstGroup = start + 31;
    const lastGroup = Math.min(start + BATCH_SIZE + 30, 40);

    console.log(`\nRefreshing Groups ${firstGroup} → ${lastGroup}...`);

    await Promise.all(
      batch.map((page, index) => reloadPage(page, start + index + 31)),
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

    console.log(`Group ${i + 31}: Found ${urls.length} post links`);

    allUrls.push(...urls);
  }

  return allUrls;
}

async function checkForNewPosts(pages, knownPosts) {
  console.log(`\n========== Checking Groups 31 → 40 ==========`);

  await reloadAllGroups(pages);

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

  console.log(`Loaded ${knownPosts.size} known posts`);

  const browser = await puppeteer.launch({
    headless: true,
    browser: "firefox",
    executablePath: process.env.EXECUTABLE_PATH_FIREFOX,
    userDataDir: process.env.USER_DATA_DIR_4,
  });

  const pages = [];

  for (let i = 0; i < groupUrls.length; i++) {
    const page = await browser.newPage();

    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

    pages.push(page);
  }

  for (let i = 0; i < pages.length; i++) {
    await openGroup(pages[i], groupUrls[i], i + 31);
  }

  console.log("\nCollecting initial posts...");

  const initialUrls = await getPostUrls(pages);

  for (const url of initialUrls) {
    const postId = getPostId(cleanPostUrl(url));

    if (postId) {
      knownPosts.add(postId);
    }
  }

  saveKnownPosts(knownPosts);

  console.log(`Initial posts saved: ${knownPosts.size}`);

  while (true) {
    await checkForNewPosts(pages, knownPosts);

    console.log(
      `\nWaiting ${CHECK_INTERVAL / 1000} seconds before next check...`,
    );

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
  }
}

startMonitoring().catch((error) => {
  console.error("Fatal error:", error);
});
