import puppeteer from "puppeteer";
import axios from "axios";
import "dotenv/config";
import fs from "fs";

const token = process.env.BOT_TOKEN;
const chatId1 = process.env.CHAT_ID1;
const chatId2 = process.env.CHAT_ID2;

const groupUrls = [
  process.env.FACEBOOK_GROUP,
  process.env.FACEBOOK_GROUP2,
  process.env.FACEBOOK_GROUP3,
  process.env.FACEBOOK_GROUP4,
  process.env.FACEBOOK_GROUP5,
  process.env.FACEBOOK_GROUP6,
  process.env.FACEBOOK_GROUP7,
  process.env.FACEBOOK_GROUP8,
  process.env.FACEBOOK_GROUP9,
  process.env.FACEBOOK_GROUP10,
];

const CHECK_INTERVAL = 30000;
const RENDER_WAIT = 5000;
const NAVIGATION_TIMEOUT = 60000;
const BATCH_SIZE = 5;

const SEEN_POSTS_FILE = "seen-posts-1.json";

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

async function sendTelegramMessage(text) {
  const chatIds = [chatId1, chatId2];

  try {
    for (const chatId of chatIds) {
      if (!chatId) continue;

      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: text,
      });

      console.log(`Telegram message sent to ${chatId}!`);
    }

    return true;
  } catch (error) {
    console.error("Telegram error:", error.response?.data || error.message);

    return false;
  }
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

    const firstGroup = start + 1;
    const lastGroup = Math.min(start + BATCH_SIZE, 10);

    console.log(`\nRefreshing Groups ${firstGroup} → ${lastGroup}...`);

    await Promise.all(
      batch.map((page, index) => reloadPage(page, start + index + 1)),
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

    console.log(`Group ${i + 1}: Found ${urls.length} post links`);

    allUrls.push(...urls);
  }

  return allUrls;
}

async function checkForNewPosts(pages, knownPosts) {
  console.log(`\n========== Checking Groups 1 → 10 ==========`);

  await reloadAllGroups(pages);

  const rawUrls = await getPostUrls(pages);

  const cleanUrls = rawUrls.map(cleanPostUrl).filter(Boolean);

  const uniqueUrls = [...new Set(cleanUrls)];

  console.log(`Total unique posts found: ${uniqueUrls.length}`);

  for (const url of uniqueUrls) {
    const postId = getPostId(url);

    if (!postId || knownPosts.has(postId)) {
      continue;
    }

    console.log(`\nNEW POST FOUND: ${url}`);

    const sent = await sendTelegramMessage(url);

    if (sent) {
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
    userDataDir: process.env.USER_DATA_DIR_1,
  });

  const pages = [];

  for (let i = 0; i < groupUrls.length; i++) {
    const page = await browser.newPage();

    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

    pages.push(page);
  }

  for (let i = 0; i < pages.length; i++) {
    await openGroup(pages[i], groupUrls[i], i + 1);
  }

  console.log("\nCollecting initial posts...");

  const initialUrls = await getPostUrls(pages);

  for (const url of initialUrls) {
    const cleanUrl = cleanPostUrl(url);
    const postId = getPostId(cleanUrl);

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
