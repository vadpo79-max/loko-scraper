import express from "express";
import puppeteer from "puppeteer";

const app = express();
const PORT = process.env.PORT || 8080;

async function scrapeFixtures() {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox","--disable-setuid-sandbox"],
    headless: "new"
  });

  // --- календарь ---
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ru,en;q=0.9" });
  await page.goto("https://www.fclm.ru/schedule/", { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 800)); });

  // берём видимые строки текста
  const scheduleLines = await page.evaluate(() =>
    document.body.innerText.split("\n").map(s => s.trim()).filter(Boolean)
  );

  // --- билеты ---
  const page2 = await browser.newPage();
  await page2.setUserAgent(await page.browser().userAgent());
  await page2.setExtraHTTPHeaders({ "Accept-Language": "ru,en;q=0.9" });
  await page2.goto("https://www.fclm.ru/tickets/", { waitUntil: "networkidle2", timeout: 60000 });

  const ticketBlocks = await page2.evaluate(() => {
    const out = [];
    const links = Array.from(document.querySelectorAll("a"));
    for (const a of links) {
      if (!/(купить билеты|Купить билеты|Купить|Билеты)/i.test(a.innerText || "")) continue;
      let el = a;
      for (let i=0; i<6 && el && el.parentElement; i++) {
        el = el.parentElement;
        if ((el.innerText || "").trim().length > 40) break;
      }
      out.push({ href: a.href, blockText: (el?.innerText || a.innerText || "").trim() });
    }
    return out;
  });

  await browser.close();
  return { scheduleLines, ticketBlocks };
}

function parseFixtures(lines) {
  const year = new Date().getFullYear();
  const events = [];
  for (const L of lines) {
    const dateM = L.match(/\b(\d{1,2})\.(\d{1,2})\b/);
    const timeM = L.match(/\b(\d{1,2}):(\d{2})\b/);
    const teamsM = L.match(/(.+?)\s*(?:vs|—|-|:)\s*(.+)/i);
    if (!dateM || !timeM || !teamsM) continue;

    const dd = +dateM[1], mm = +dateM[2];
    const hh = +timeM[1], mi = +timeM[2];
    const A = teamsM[1].trim(), B = teamsM[2].trim();
    const isHome = /локомотив/i.test(A) && !/локомотив/i.test(B);
    const isAway = /локомотив/i.test(B) && !/локомотив/i.test(A);
    if (!isHome && !isAway) continue;

    const start = new Date(year, mm-1, dd, hh, mi);
    const end   = new Date(start.getTime() + 2*3600*1000);
    events.push({
      title: isHome ? `Локомотив — ${B}` : `${A} — Локомотив`,
      isHome,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      location: isHome ? "РЖД Арена, Москва" : ""
    });
  }
  // убираем дубли по title+start
  const key = e => e.title + "|" + e.startISO;
  return [...new Map(events.map(e => [key(e), e])).values()];
}

function buildTicketMap(blocks) {
  const map = new Map();
  for (const b of blocks) {
    const oppM  = b.blockText.match(/Локомотив\s*(?:vs|—|-|:)\s*([A-Za-zА-Яа-яёЁ0-9.\- ]+)/i);
    const dateM = b.blockText.match(/\b(\d{1,2})\.(\d{1,2})\b/);
    const timeM = b.blockText.match(/\b(\d{1,2}):(\d{2})\b/);
    if (!oppM || !dateM || !timeM) continue;
    const opp = oppM[1].trim().replace(/\s+/g," ").toLowerCase();
    const dd = String(dateM[1]).padStart(2,"0");
    const mm = String(dateM[2]).padStart(2,"0");
    const hh = String(timeM[1]).padStart(2,"0");
    const mi = String(timeM[2]).padStart(2,"0");
    const key = `home:${mm}-${dd} ${hh}:${mi} ${opp}`;
    map.set(key, b.href);
  }
  return map;
}

const app = express();
app.get("/loko-fixtures", async (req, res) => {
  try {
    const { scheduleLines, ticketBlocks } = await scrapeFixtures();
    const fixtures = parseFixtures(scheduleLines);
    const tmap = buildTicketMap(ticketBlocks);
    fixtures.forEach(f => {
      if (!f.isHome) return;
      const d = new Date(f.startISO);
      const key = `home:${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} ${f.title.replace(/^Локомотив — /,'').toLowerCase()}`;
      if (tmap.has(key)) f.ticketUrl = tmap.get(key);
    });
    res.json({ ok: true, count: fixtures.length, fixtures });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get("/", (req,res)=>res.send("OK"));
app.listen(PORT, () => console.log(`listening on ${PORT}`));
