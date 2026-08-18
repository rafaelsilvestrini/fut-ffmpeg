const express = require("express");
const axios = require("axios");
const { connect } = require("puppeteer-real-browser");
const cheerio = require("cheerio");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
// Força o caminho do Chrome para o puppeteer-real-browser achar no Easypanel
process.env.CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const LOCAL_AUDIO_PATH = path.join(__dirname, "audio", "audio.mp3");
const VIDEO_DURATION_SECONDS = 30;
const AUDIO_VOLUME = 0.1;
const TRANSFERMARKT_LATEST_TRANSFERS_URL =
  "https://www.transfermarkt.com/transfers/neuestetransfers/statistik/plus/?plus=0&galerie=0&wettbewerb_id=alle&verein_land_id=&selectedOptionInternalType=top15&land_id=&minMarktwert=0&maxMarktwert=500.000.000&minAbloese=0&maxAbloese=500.000.000&yt0=Show";
const TRANSFERMARKT_BASE_URL = "https://www.transfermarkt.com";
const ALLOWED_DOMAIN = "fibrazil.es";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--mute-audio",
  "--disable-blink-features=AutomationControlled",
];

const getPuppeteerLaunchOptions = async () => {
  const { browser, page } = await connect({
    headless: "new",
    args: PUPPETEER_ARGS,
    turnstile: true,
    disableXvfb: true,
  });

  return { browser, page };
};

const hostnameFromHeader = (value) => {
  if (!value) return "";
  try {
    return new URL(
      value.includes("://") ? value : `http://${value}`,
    ).hostname.toLowerCase();
  } catch (error) {
    return "";
  }
};

const isAllowedHostname = (hostname) => {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    LOCAL_HOSTS.has(normalized) ||
    normalized === ALLOWED_DOMAIN ||
    normalized.endsWith(`.${ALLOWED_DOMAIN}`)
  );
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const requestHost = req.headers.host;
  const originHost = hostnameFromHeader(origin);
  const refererHost = hostnameFromHeader(referer);
  const host = hostnameFromHeader(requestHost);
  const allowed = origin
    ? isAllowedHostname(originHost)
    : isAllowedHostname(refererHost) || isAllowedHostname(host);

  if (!allowed) {
    return res.status(403).json({ error: "Origem nao autorizada" });
  }

  if (origin && isAllowedHostname(originHost)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json({ limit: "10mb" }));

const toHighRes = (url) => {
  if (!url) return "";
  return url.replace(/\/tiny\//g, "/head/");
};

const urlToBase64 = async (url) => {
  if (!url) return "";
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    const mimeType = response.headers["content-type"] || "image/png";
    return `data:${mimeType};base64,${Buffer.from(response.data).toString("base64")}`;
  } catch (err) {
    return "";
  }
};

const getBrasiliaDate = () => {
  const now = new Date();
  return {
    iso: now.toISOString(),
    brasilia: now.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
  };
};

const parseLatestTransfersHtml = (htmlContent, limit = 25) => {
  const $ = cheerio.load(htmlContent);
  const absoluteUrl = (url) => {
    if (!url) return "";
    return new URL(url, TRANSFERMARKT_BASE_URL).href;
  };
  const cleanText = (value) => (value || "").replace(/\s+/g, " ").trim();
  const imageUrl = (img) => {
    const src = img.attr("data-src") || img.attr("src") || "";
    return absoluteUrl(src).replace(/\/tiny\//g, "/head/");
  };
  const parsePlayer = (cell) => {
    const playerLink = cell
      .find('td.hauptlink a[href*="/profil/spieler/"]')
      .first();
    const playerUrl = absoluteUrl(playerLink.attr("href"));

    return {
      name: cleanText(playerLink.text()),
      id: playerUrl,
      url: playerUrl,
      position: cleanText(
        cell.find("table.inline-table tr").eq(1).find("td").last().text(),
      ),
      image_url: imageUrl(cell.find("img").first()),
    };
  };
  const parseClub = (cell) => {
    const clubLink = cell
      .find('td.hauptlink a[href*="/startseite/verein/"]')
      .first();
    const fallbackClubLink = cell
      .find('a[href*="/startseite/verein/"]')
      .first();
    const selectedClubLink = clubLink.length ? clubLink : fallbackClubLink;
    const leagueLink = cell.find('a[href*="/transfers/wettbewerb/"]').first();
    const clubImg = cell.find("img.tiny_wappen").first();

    return {
      name:
        cleanText(selectedClubLink.text()) || cleanText(clubImg.attr("alt")),
      full_name:
        cleanText(selectedClubLink.attr("title")) ||
        cleanText(clubImg.attr("title")),
      url: absoluteUrl(selectedClubLink.attr("href")),
      image_url: imageUrl(clubImg),
      league: cleanText(leagueLink.text()),
      league_url: absoluteUrl(leagueLink.attr("href")),
    };
  };
  const parseFee = (cell) => {
    const feeLink = cell.find("a").first();
    const value = cleanText(feeLink.text() || cell.text());

    return {
      value,
      type: value,
      url: absoluteUrl(feeLink.attr("href")),
    };
  };

  return $("table.items > tbody > tr")
    .filter((_, row) => $(row).children("td").length >= 6)
    .slice(0, limit)
    .map((_, row) => {
      const cells = $(row).children("td");
      const nationalities = cells
        .eq(2)
        .find("img")
        .map((__, img) => cleanText($(img).attr("title") || $(img).attr("alt")))
        .get()
        .filter(Boolean);

      return {
        player: parsePlayer(cells.eq(0)),
        age: cleanText(cells.eq(1).text()),
        nationalities,
        left: parseClub(cells.eq(3)),
        joined: parseClub(cells.eq(4)),
        fee: parseFee(cells.eq(5)),
      };
    })
    .get();
};

const fetchTransfermarktHtmlWithAxios = async () => {
  const response = await axios.get(TRANSFERMARKT_LATEST_TRANSFERS_URL, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  return response.data;
};

const fetchTransfermarktHtmlWithPuppeteer = async () => {
  const isLinux = process.platform === "linux";
  const isHeadless = isLinux ? true : true; // ou mantendo sua regra de headless
  let browser, page;

  try {
    const { browser: connectedBrowser, page: connectedPage } = await connect({
      headless: isHeadless,
      customConfig: {
        chromePath: process.env.CHROME_PATH,
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      turnstile: true,
      disableXvfb: true,
    });

    browser = connectedBrowser;
    page = connectedPage;

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.goto(TRANSFERMARKT_LATEST_TRANSFERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForSelector("table.items > tbody > tr", { timeout: 30000 });

    return await page.content();
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
};
const scrapeLatestTransfers = async (limit = 25) => {
  let htmlContent = "";

  try {
    htmlContent = await fetchTransfermarktHtmlWithAxios();
    const transfers = parseLatestTransfersHtml(htmlContent, limit);
    if (transfers.length > 0) return transfers;
  } catch (error) {
    htmlContent = "";
  }

  htmlContent = await fetchTransfermarktHtmlWithPuppeteer();
  return parseLatestTransfersHtml(htmlContent, limit);
};

const formatMarketValue = (val, lang = "pt") => {
  if (!val) return "";

  let num = null;
  let str = val.toString().trim().toLowerCase();

  if (str.includes("mil") || str.includes("k")) {
    let match = str.match(/[\d.,]+/);
    if (match) {
      num = parseFloat(match[0].replace(",", ".")) * 1000;
    }
  } else if (str.includes("mi") || str.includes("m")) {
    let match = str.match(/[\d.,]+/);
    if (match) {
      num = parseFloat(match[0].replace(",", ".")) * 1000000;
    }
  } else {
    let match = str.match(/[\d.,]+/);
    if (match) {
      num = parseFloat(match[0].replace(",", "."));
    }
  }

  if (num === null || isNaN(num)) return val;

  let symbol = "€";
  let formattedNum = "";
  let suffix = "";

  if (num >= 1000000) {
    let valM = num / 1000000;
    formattedNum = Number.isInteger(valM)
      ? valM.toString()
      : valM.toFixed(1).replace(".", ",");
    suffix = "m";
  } else if (num >= 1000) {
    let valK = num / 1000;
    formattedNum = Number.isInteger(valK)
      ? valK.toString()
      : valK.toFixed(1).replace(".", ",");
    suffix = "k";
  } else {
    formattedNum = num.toString();
  }

  const langLower = lang.toLowerCase();
  if (langLower === "en") {
    formattedNum = formattedNum.replace(",", ".");
    return `${symbol}${formattedNum}${suffix}`;
  } else if (langLower === "es" || langLower === "pt") {
    return `${formattedNum}${suffix} ${symbol}`;
  }

  return `${formattedNum}${suffix} ${symbol}`;
};

function parseTransfermarktHtml(htmlContent, lang = "pt") {
  if (!htmlContent) return [];
  const $ = cheerio.load(htmlContent);
  const points = [];
  $("g.chart-dots image").each((i, el) => {
    const href = $(el).attr("xlink:href") || $(el).attr("href");
    if (href) {
      points.push({ club_logo_url: href });
    }
  });
  return points;
}

const renderImageWithPuppeteer = async (htmlContent) => {
  const isLinux = process.platform === "linux";
  const isHeadless = isLinux ? true : true;
  let browser, page;

  try {
    const { browser: connectedBrowser, page: connectedPage } = await connect({
      headless: isHeadless,
      customConfig: {
        chromePath: process.env.CHROME_PATH,
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      turnstile: true,
      disableXvfb: true,
    });

    browser = connectedBrowser;
    page = connectedPage;

    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 2 });
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });

    return await page.screenshot({ type: "png" });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
};

const convertImageToMp4 = (imageBuffer) =>
  new Promise((resolve, reject) => {
    const requestTmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "transfer-video-"),
    );
    const imgPath = path.join(requestTmpDir, "card.png");
    const videoOutputPath = path.join(requestTmpDir, "video.mp4");
    const cleanup = () => {
      fs.rmSync(requestTmpDir, { recursive: true, force: true });
    };

    fs.writeFileSync(imgPath, imageBuffer);

    const duration = VIDEO_DURATION_SECONDS;

    const hasLocalAudio = fs.existsSync(LOCAL_AUDIO_PATH);

    const command = ffmpeg()
      .input(imgPath)
      .inputOptions(["-loop 1", "-t", `${duration}`]);

    if (hasLocalAudio) {
      command.input(LOCAL_AUDIO_PATH).inputOptions([
        "-stream_loop -1", // Repete o áudio caso ele seja menor que a duração total
      ]);
    }

    command
      .fps(30)
      .videoCodec("libx264")
      .outputOptions([
        "-preset ultrafast",
        "-crf 26",
        "-pix_fmt yuv420p",
        "-vf scale=1080:1920:flags=lanczos",
        "-t",
        `${duration}`, // Corta exatamente na duração especificada
      ]);

    if (hasLocalAudio) {
      command
        .audioCodec("aac")
        .audioBitrate("128k")
        .audioFilters(`volume=${AUDIO_VOLUME}`);
    }

    command
      .output(videoOutputPath)
      .on("end", () => {
        try {
          const videoBuffer = fs.readFileSync(videoOutputPath);
          resolve({
            mime_type: "video/mp4",
            filename: "reels.mp4",
            duration_seconds: duration,
            blob: `data:video/mp4;base64,${videoBuffer.toString("base64")}`,
          });
        } catch (error) {
          reject(error);
        } finally {
          cleanup();
        }
      })
      .on("error", (err) => {
        cleanup();
        reject(err);
      })
      .run();
  });

const generateTransferHtml = ({
  player_name,
  player_age,
  season,
  market_value_then,
  fee,
  bgB64,
  playerB64,
  fromB64,
  toB64,
  handshakeB64,
  logoB64,
  instagram_handle,
}) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            width: 1080px;
            height: 1920px;
            background: #000000;
            font-family: 'Montserrat', sans-serif;
            position: relative;
            overflow: hidden;
        }
        ${
          bgB64
            ? `
        .background-img {
            position: absolute;
            top: 0;
            left: 0;
            width: 1080px;
            height: 1920px;
            object-fit: cover;
            object-position: center top;
            z-index: 1;
        }
        `
            : ""
        }
        .dark-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.45);
            z-index: 2;
        }
        .shadow-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 850px;
            background: linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0.85) 50%, rgba(0,0,0,0) 100%);
            z-index: 3;
        }
        .watermark-insta {
            position: absolute;
            top: 60px;
            left: 60px;
            color: rgba(255, 255, 255, 0.45);
            font-size: 24px;
            font-weight: 800;
            letter-spacing: 1.5px;
            text-shadow: 0 2px 8px rgba(0,0,0,0.8);
            z-index: 4;
        }
        ${
          logoB64
            ? `
        .brand-logo-container {
            position: absolute;
            top: 60px;
            left: 0;
            width: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 4;
        }
        .logo-bg-wrapper {
            background-color: #FFFFFF;
            border-radius: 6px;
            padding: 1px;
            display: inline-flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .brand-logo {
            max-width: 320px;
            max-height: 115px;
            object-fit: contain;
            display: block;
        }
        `
            : ""
        }
        .info-wrapper {
            position: absolute;
            bottom: 340px;
            left: 0;
            width: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
            z-index: 4;
        }
        .season-tag {
            background: rgba(0, 0, 0, 0.7);
            border: 1px solid rgba(63, 158, 64, 0.5);
            color: #3F9E40;
            padding: 10px 30px;
            border-radius: 24px;
            text-align: center;
        }
        .season-main {
            font-size: 28px;
            font-weight: 800;
            letter-spacing: 2px;
            text-transform: uppercase;
        }
        .season-sub {
            font-size: 14px;
            font-weight: 700;
            color: #A0A0A0;
            letter-spacing: 1px;
            margin-top: 2px;
        }
        .financial-info {
            display: flex;
            justify-content: center;
            gap: 30px;
        }
        .info-card {
            background: rgba(18, 18, 18, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(15px);
            padding: 20px 34px;
            border-radius: 16px;
            text-align: center;
            min-width: 310px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        .info-card.highlight {
            border-color: #3F9E40;
            background: rgba(63, 158, 64, 0.1);
        }
        .info-label {
            color: #FFFFFF;
            font-size: 18px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 1.2px;
        }
        .info-sublabel {
            color: #A0A0A0;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-top: 2px;
            margin-bottom: 6px;
        }
        .info-value {
            color: #FFFFFF;
            font-size: 48px;
            font-weight: 900;
        }
        .info-card.highlight .info-value {
            color: #3F9E40;
        }
        .transfer-row {
            position: absolute;
            bottom: 160px;
            left: 0;
            width: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 40px;
            z-index: 4;
        }
        .badge {
            width: 170px;
            height: 170px;
            object-fit: contain;
            image-rendering: -webkit-optimize-contrast;
            filter: drop-shadow(0 10px 20px rgba(0,0,0,0.8));
        }
        .handshake-icon {
            width: 92px;
            height: 92px;
            object-fit: contain;
            filter: drop-shadow(0 0 20px rgba(63, 158, 64, 0.8));
        }
        .name-banner {
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            background: #000000;
            border-top: 5px solid #3F9E40;
            padding: 34px 42px;
            text-align: center;
            z-index: 4;
        }
        .player-name {
            color: #FFFFFF;
            font-size: 58px;
            font-weight: 900;
            letter-spacing: 2px;
            line-height: 1.05;
            text-transform: uppercase;
            overflow-wrap: break-word;
        }
    </style>
</head>
<body>
    ${bgB64 ? `<img class="background-img" src="${bgB64}" />` : ""}
    <div class="dark-overlay"></div>
    <div class="shadow-overlay"></div>
    <div class="watermark-insta">${instagram_handle}</div>
    ${
      logoB64
        ? `
    <div class="brand-logo-container">
        <div class="logo-bg-wrapper">
            <img class="brand-logo" src="${logoB64}" />
        </div>
    </div>
    `
        : ""
    }
    <div class="info-wrapper">
        ${
          season
            ? `
        <div class="season-tag">
            <div class="season-main">SEASON ${season}</div>
            <div class="season-sub">TEMPORADA</div>
        </div>
        `
            : ""
        }
        ${
          market_value_then || fee
            ? `
        <div class="financial-info">
            ${
              market_value_then
                ? `
            <div class="info-card">
                <div class="info-label">MARKET VALUE</div>
                <div class="info-sublabel">VALOR DE MERCADO</div>
                <div class="info-value">${market_value_then}</div>
            </div>
            `
                : ""
            }
            ${
              fee
                ? `
            <div class="info-card highlight">
                <div class="info-label">TRANSFER FEE</div>
                <div class="info-sublabel">VALOR DA COMPRA / FICHAJE</div>
                <div class="info-value">${fee}</div>
            </div>
            `
                : ""
            }
        </div>
        `
            : ""
        }
    </div>
    <div class="transfer-row">
        ${fromB64 ? `<img class="badge" src="${fromB64}" />` : ""}
        ${handshakeB64 ? `<img class="handshake-icon" src="${handshakeB64}" />` : ""}
        ${toB64 ? `<img class="badge" src="${toB64}" />` : ""}
    </div>
    <div class="name-banner">
        <div class="player-name">
            ${player_name || ""} ${player_age ? `(${player_age})` : ""}
        </div>
    </div>
</body>
</html>
`;

const generateMarketValueHtml = ({
  player_name,
  bgB64,
  logoB64,
  instagram_handle,
  historyWithB64,
  lang = "pt",
}) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            width: 1080px;
            height: 1920px;
            background: #000000;
            font-family: 'Montserrat', sans-serif;
            position: relative;
            overflow: hidden;
        }
        ${
          bgB64
            ? `
        .background-img {
            position: absolute;
            top: 0;
            left: 0;
            width: 1080px;
            height: 1920px;
            object-fit: cover;
            object-position: center top;
            z-index: 1;
        }
        `
            : ""
        }
        .dark-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.45);
            z-index: 2;
        }
        .shadow-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 1200px;
            background: linear-gradient(to top, 
                rgba(0,0,0,1) 0%, 
                rgba(0,0,0,0.95) 40%, 
                rgba(0,0,0,0.7) 70%, 
                rgba(0,0,0,0) 100%);
            z-index: 3;
        }
        .watermark-insta {
            position: absolute;
            top: 60px;
            left: 60px;
            color: rgba(255, 255, 255, 0.45);
            font-size: 24px;
            font-weight: 800;
            letter-spacing: 1.5px;
            text-shadow: 0 2px 8px rgba(0,0,0,0.8);
            z-index: 4;
        }
        ${
          logoB64
            ? `
        .brand-logo-container {
            position: absolute;
            top: 60px;
            right: 60px;
            z-index: 4;
        }
        .logo-bg-wrapper {
            background-color: #FFFFFF;
            border-radius: 6px;
            padding: 1px;
            display: inline-flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .brand-logo {
            max-width: 250px;
            max-height: 92px;
            object-fit: contain;
            display: block;
        }
        `
            : ""
        }
        .timeline-container {
            position: absolute;
            bottom: 80px;
            left: 0;
            width: 100%;
            padding: 0 40px;
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            align-items: flex-end;
            gap: 34px 20px;
            z-index: 4;
            max-height: 1300px;
        }
        .timeline-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 14px;
            width: calc(33.33% - 20px);
        }
        .value-tag {
            background: #FFFFFF;
            color: #000000;
            font-size: 30px;
            font-weight: 900;
            padding: 8px 18px;
            border-radius: 6px;
            box-shadow: 0 6px 20px rgba(0,0,0,0.7);
            white-space: nowrap;
            text-transform: lowercase;
            letter-spacing: 0.5px;
        }
        .club-badge {
            width: 140px;
            height: 140px;
            object-fit: contain;
            filter: drop-shadow(0 10px 20px rgba(0,0,0,0.85));
        }
        .year-label {
            color: #FFFFFF;
            font-size: 38px;
            font-weight: 900;
            letter-spacing: 1px;
            text-shadow: 0 4px 10px rgba(0,0,0,0.9);
        }
        .player-header {
            position: absolute;
            top: 160px;
            left: 0;
            width: 100%;
            text-align: center;
            z-index: 4;
        }
        .player-title {
            color: #FFFFFF;
            font-size: 64px;
            font-weight: 900;
            letter-spacing: 3px;
            line-height: 1.05;
            text-transform: uppercase;
            text-shadow: 0 4px 20px rgba(0,0,0,0.9);
            overflow-wrap: break-word;
            padding: 0 46px;
        }
        .subtitle-main {
            color: #3F9E40;
            font-size: 28px;
            font-weight: 900;
            letter-spacing: 3px;
            text-transform: uppercase;
            margin-top: 6px;
        }
        .subtitle-sub {
            color: #A0A0A0;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            margin-top: 3px;
        }
    </style>
</head>
<body>
    ${bgB64 ? `<img class="background-img" src="${bgB64}" />` : ""}
    <div class="dark-overlay"></div>
    <div class="shadow-overlay"></div>
    <div class="watermark-insta">${instagram_handle}</div>
    ${
      logoB64
        ? `
    <div class="brand-logo-container">
        <div class="logo-bg-wrapper">
            <img class="brand-logo" src="${logoB64}" />
        </div>
    </div>
    `
        : ""
    }
    ${
      player_name
        ? `
    <div class="player-header">
        <div class="player-title">${player_name}</div>
        <div class="subtitle-main">MARKET VALUE EVOLUTION</div>
        <div class="subtitle-sub">EVOLUÇÃO DO VALOR DE MERCADO / EVOLUCIÓN DEL VALOR DE MERCADO</div>
    </div>
    `
        : ""
    }
    <div class="timeline-container">
        ${historyWithB64
          .map(
            (item) => `
            <div class="timeline-item">
                ${item.formatted_value ? `<div class="value-tag">${item.formatted_value}</div>` : ""}
                ${item.club_logo_b64 ? `<img class="club-badge" src="${item.club_logo_b64}" />` : ""}
                ${item.year ? `<div class="year-label">${item.year}</div>` : ""}
            </div>
        `,
          )
          .join("")}
    </div>
</body>
</html>
`;

app.get("/api/scrape-transfermarkt-transfers", async (req, res) => {
  try {
    const limitInput = parseInt(req.query.limit);
    const limit =
      Number.isInteger(limitInput) && limitInput > 0
        ? Math.min(limitInput, 100)
        : 25;
    const scraped_at = getBrasiliaDate();
    const scrapedTransfers = await scrapeLatestTransfers(limit);
    const transfers = scrapedTransfers.map((transfer) => ({
      ...transfer,
      date: scraped_at.brasilia,
      date_iso: scraped_at.iso,
    }));

    return res.json({
      source_url: TRANSFERMARKT_LATEST_TRANSFERS_URL,
      scraped_at,
      limit,
      count: transfers.length,
      transfers,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Erro ao fazer scraping dos dados da Transfermarkt",
      details: error.message,
    });
  }
});

app.post("/api/generate-transfer-card", async (req, res) => {
  try {
    const {
      player_name,
      player_age,
      season,
      market_value_then,
      fee,
      background_image_url,
      player_image_url,
      from_team_url,
      to_team_url,
      logo_url = "https://futebolnatv.info/assets/logo/logo_green.png",
      handshake_icon_url,
      instagram_handle = "@futebolnatv.info",
    } = req.body;

    const [bgB64, playerB64, fromB64, toB64, handshakeB64, logoB64] =
      await Promise.all([
        urlToBase64(toHighRes(background_image_url)),
        urlToBase64(toHighRes(player_image_url)),
        urlToBase64(toHighRes(from_team_url)),
        urlToBase64(toHighRes(to_team_url)),
        urlToBase64(toHighRes(handshake_icon_url)),
        urlToBase64(logo_url),
      ]);

    const htmlContent = generateTransferHtml({
      player_name,
      player_age,
      season,
      market_value_then,
      fee,
      bgB64,
      playerB64,
      fromB64,
      toB64,
      handshakeB64,
      logoB64,
      instagram_handle,
    });

    const imageBuffer = await renderImageWithPuppeteer(htmlContent);
    const video = await convertImageToMp4(imageBuffer);
    return res.json(video);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate-market-value-card", async (req, res) => {
  try {
    const {
      player_name,
      background_image_url,
      logo_url = "https://futebolnatv.info/assets/logo/logo_green.png",
      instagram_handle = "@futebolnatv.info",
      lang = "pt",
      transfermarkt_html,
      history = [],
    } = req.body;

    let marketHistory = [...history];

    if (transfermarkt_html && marketHistory.length === 0) {
      const parsedClubs = parseTransfermarktHtml(transfermarkt_html, lang);
      marketHistory = parsedClubs.map((item, index) => ({
        year: item.year || `202${index + 1}`,
        value: item.value || "500 mil €",
        club_logo_url: item.club_logo_url,
      }));
    }

    marketHistory.sort((a, b) => {
      const yearA = parseInt(a.year) || 0;
      const yearB = parseInt(b.year) || 0;
      return yearA - yearB;
    });

    const [bgB64, logoB64] = await Promise.all([
      urlToBase64(background_image_url),
      urlToBase64(logo_url),
    ]);

    const historyWithB64 = await Promise.all(
      marketHistory.map(async (item) => ({
        ...item,
        formatted_value: formatMarketValue(item.value, lang),
        club_logo_b64: await urlToBase64(item.club_logo_url),
      })),
    );

    const htmlContent = generateMarketValueHtml({
      player_name,
      bgB64,
      logoB64,
      instagram_handle,
      historyWithB64,
      lang,
    });

    const imageBuffer = await renderImageWithPuppeteer(htmlContent);
    const video = await convertImageToMp4(imageBuffer);
    return res.json(video);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
