const express = require("express");
const axios = require("axios");
const { connect } = require("puppeteer-real-browser");
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const app = express();

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const PORT = Number(process.env.PORT) || 3000;

const LOCAL_AUDIO_PATH = path.join(
  __dirname,
  "audio",
  "audio.mp3",
);

const VIDEO_DURATION_SECONDS = 30;
const AUDIO_VOLUME = 0.1;

const TRANSFERMARKT_LATEST_TRANSFERS_URL =
  "https://www.transfermarkt.com/transfers/neuestetransfers/statistik/plus/?plus=0&galerie=0&wettbewerb_id=alle&verein_land_id=&selectedOptionInternalType=top15&land_id=&minMarktwert=0&maxMarktwert=500.000.000&minAbloese=0&maxAbloese=500.000.000&yt0=Show";

const TRANSFERMARKT_BASE_URL =
  "https://www.transfermarkt.com";

const TRANSFERMARKT_API_BASE_URL =
  "https://tmapi.transfermarkt.technology";

const TRANSFERMARKT_GRAPH_BASE_URLS = [
  TRANSFERMARKT_BASE_URL,
  "https://www.transfermarkt.us",
  "https://www.transfermarkt.co.uk",
  "https://www.transfermarkt.de",
];

const ALLOWED_DOMAIN = "fibrazil.es";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

const FALLBACK_PLAYER_IMAGE_PATH =
  "/img/bg.jpeg";

const HISTORY_PACK_PREFIX =
  "h1.";

const toBase64Url =
  (buffer) =>
    buffer
      .toString(
        "base64",
      )
      .replace(
        /\+/g,
        "-",
      )
      .replace(
        /\//g,
        "_",
      )
      .replace(
        /=+$/g,
        "",
      );

const fromBase64Url =
  (value) => {
    const base64 =
      value
        .replace(
          /-/g,
          "+",
        )
        .replace(
          /_/g,
          "/",
        );

    return Buffer.from(
      base64.padEnd(
        Math.ceil(
          base64.length / 4,
        ) * 4,
        "=",
      ),
      "base64",
    );
  };

const packMarketValueHistory =
  (history = []) => {
    const compactHistory =
      history.map(
        (item) => [
          item.year || "",
          item.value || "",
          item.club_logo_url || "",
        ],
      );

    const payload =
      Buffer.from(
        JSON.stringify(
          compactHistory,
        ),
        "utf8",
      );

    return (
      HISTORY_PACK_PREFIX +
      toBase64Url(
        zlib.deflateRawSync(
          payload,
        ),
      )
    );
  };

const unpackMarketValueHistory =
  (packedHistory) => {
    if (
      typeof packedHistory !==
        "string" ||
      !packedHistory.startsWith(
        HISTORY_PACK_PREFIX,
      )
    ) {
      return [];
    }

    const compressed =
      fromBase64Url(
        packedHistory.slice(
          HISTORY_PACK_PREFIX.length,
        ),
      );

    const json =
      zlib
        .inflateRawSync(
          compressed,
        )
        .toString(
          "utf8",
        );

    const compactHistory =
      JSON.parse(
        json,
      );

    if (
      !Array.isArray(
        compactHistory,
      )
    ) {
      return [];
    }

    return compactHistory.map(
      (item) => ({
        year:
          String(
            item?.[0] || "",
          ),

        value:
          String(
            item?.[1] || "",
          ),

        club_logo_url:
          String(
            item?.[2] || "",
          ),
      }),
    );
  };

/* ============================================================
   CHROME / PUPPETEER
   ============================================================ */

/*
 * O Puppeteer baixa o Chrome para o cache padrão:
 *
 * /root/.cache/puppeteer/chrome/
 *
 * Procuramos automaticamente o executável.
 *
 * Nao usamos PUPPETEER_EXECUTABLE_PATH.
 */

const findChromeExecutable = () => {
  const candidates = [];

  /*
   * Preferimos o Chrome estavel do sistema, como no projeto flight.
   */
  candidates.push(
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/opt/google/chrome/google-chrome",
  );

  /*
   * Permite caminho manual caso exista no ambiente.
   */
  if (process.env.CHROME_PATH) {
    candidates.push(
      process.env.CHROME_PATH,
    );
  }

  for (const candidate of candidates) {
    if (
      candidate &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }

  /*
   * Cache padrão do Puppeteer.
   *
   * Exemplo:
   *
   * /root/.cache/puppeteer/chrome/
   *   linux-152.0.7977.42/
   *     chrome-linux64/
   *       chrome
   */

  const puppeteerCache =
    process.env.PUPPETEER_CACHE_DIR ||
    path.join(
      os.homedir(),
      ".cache",
      "puppeteer",
    );

  const chromeCacheDir = path.join(
    puppeteerCache,
    "chrome",
  );

  if (fs.existsSync(chromeCacheDir)) {
    const versions = fs
      .readdirSync(chromeCacheDir, {
        withFileTypes: true,
      })
      .filter(
        (entry) =>
          entry.isDirectory(),
      )
      .map(
        (entry) => entry.name,
      )
      .sort()
      .reverse();

    for (const version of versions) {
      const versionDir = path.join(
        chromeCacheDir,
        version,
      );

      const possibleExecutables = [
        path.join(
          versionDir,
          "chrome-linux64",
          "chrome",
        ),

        path.join(
          versionDir,
          "chrome-linux",
          "chrome",
        ),

        path.join(
          versionDir,
          "chrome",
        ),
      ];

      for (const executable of possibleExecutables) {
        if (
          fs.existsSync(executable) &&
          fs.statSync(executable).isFile()
        ) {
          return executable;
        }
      }
    }
  }

  /*
   * Último recurso:
   * procura recursivamente no cache.
   */

  const recursiveFind = (
    directory,
    maxDepth = 6,
    depth = 0,
  ) => {
    if (
      depth > maxDepth ||
      !fs.existsSync(directory)
    ) {
      return null;
    }

    let entries;

    try {
      entries = fs.readdirSync(
        directory,
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(
        directory,
        entry.name,
      );

      if (
        entry.isFile() &&
        entry.name === "chrome"
      ) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const found = recursiveFind(
          fullPath,
          maxDepth,
          depth + 1,
        );

        if (found) {
          return found;
        }
      }
    }

    return null;
  };

  return recursiveFind(
    puppeteerCache,
    6,
  );
};

const findChromeHeadlessShellExecutable = () => {
  const puppeteerCache =
    process.env.PUPPETEER_CACHE_DIR ||
    path.join(
      os.homedir(),
      ".cache",
      "puppeteer",
    );

  const chromeHeadlessShellDir = path.join(
    puppeteerCache,
    "chrome-headless-shell",
  );

  if (!fs.existsSync(chromeHeadlessShellDir)) {
    return null;
  }

  const recursiveFind = (
    directory,
    maxDepth = 6,
    depth = 0,
  ) => {
    if (
      depth > maxDepth ||
      !fs.existsSync(directory)
    ) {
      return null;
    }

    let entries;

    try {
      entries = fs.readdirSync(
        directory,
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(
        directory,
        entry.name,
      );

      if (
        entry.isFile() &&
        entry.name === "chrome-headless-shell"
      ) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const found = recursiveFind(
          fullPath,
          maxDepth,
          depth + 1,
        );

        if (found) {
          return found;
        }
      }
    }

    return null;
  };

  return recursiveFind(
    chromeHeadlessShellDir,
    6,
  );
};

const CHROME_EXECUTABLE =
  findChromeExecutable();

const CHROME_HEADLESS_SHELL_EXECUTABLE =
  findChromeHeadlessShellExecutable();

console.log("");
console.log(
  "==========================================",
);
console.log(
  " BROWSER CONFIGURATION",
);
console.log(
  "==========================================",
);
console.log(
  "Platform:",
  process.platform,
);
console.log(
  "Architecture:",
  process.arch,
);
console.log(
  "Chrome:",
  CHROME_EXECUTABLE ||
    "NOT FOUND",
);
console.log(
  "Chrome Headless Shell:",
  CHROME_HEADLESS_SHELL_EXECUTABLE ||
    "NOT FOUND",
);
console.log(
  "CHROME_PATH:",
  process.env.CHROME_PATH ||
    "not set",
);
console.log(
  "==========================================",
);
console.log("");

if (!CHROME_EXECUTABLE) {
  console.error(
    "ERRO: Chrome/Chromium não foi encontrado.",
  );
}

/*
 * IMPORTANTE:
 *
 * Não colocamos dezenas de flags aqui.
 *
 * Mantemos somente as flags necessárias
 * para o ambiente do container.
 */
const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
  "--disable-software-rasterizer",
  "--disable-sync",
  "--disk-cache-size=0",
  "--media-cache-size=0",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--no-first-run",
  "--renderer-process-limit=2",
  "--disable-blink-features=AutomationControlled",
];

const LOW_RESOURCE_VIEWPORT = {
  width: 1080,
  height: 1920,
  deviceScaleFactor: 1,
};

/*
 * Controle para não iniciar dezenas de Chrome
 * simultaneamente se chegarem várias requisições.
 */
let browserLaunchPromise = null;

/* ============================================================
   LAUNCH BROWSER
   ============================================================ */

const launchBrowser = async () => {
  if (!CHROME_EXECUTABLE) {
    throw new Error(
      "Chrome/Chromium não encontrado no cache do Puppeteer.",
    );
  }

  const userDataDir = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "transfer-browser-",
    ),
  );

  console.log("");
  console.log(
    "[Chrome] Iniciando navegador...",
  );
  console.log(
    "[Chrome] Executável:",
    CHROME_EXECUTABLE,
  );
  console.log(
    "[Chrome] UserDataDir:",
    userDataDir,
  );

  const headless =
    process.platform === "linux"
      ? true
      : false;

  console.log(
    "[Chrome] Headless:",
    headless,
  );
  console.log(
    "[Chrome] Xvfb:",
    process.env.DISPLAY
      ? `display ${process.env.DISPLAY}`
      : "sem display",
  );

  try {
    const result = await connect({
      /*
       * Usa modo real quando há display/Xvfb. Sem Xvfb,
       * cai para headless para evitar ECONNREFUSED.
       */
      headless:
        headless,

      args:
        PUPPETEER_ARGS,

      customConfig: {
        chromePath:
          CHROME_EXECUTABLE,
      },

      turnstile:
        true,

      disableXvfb:
        true,

      connectOption: {
        timeout:
          120000,

        defaultViewport:
          LOW_RESOURCE_VIEWPORT,
      },
    });

    if (
      !result ||
      !result.browser ||
      !result.page
    ) {
      throw new Error(
        "Chrome iniciou, mas o puppeteer-real-browser não retornou browser/page.",
      );
    }

    console.log(
      "[Chrome] Navegador conectado com sucesso.",
    );

    return {
      browser:
        result.browser,

      page:
        result.page,

      userDataDir,
    };
  } catch (error) {
    console.error(
      "[Chrome] Falha ao iniciar/conectar.",
    );

    console.error(
      "[Chrome] Executável:",
      CHROME_EXECUTABLE,
    );

    console.error(
      "[Chrome] UserDataDir:",
      userDataDir,
    );

    console.error(
      "[Chrome] Erro:",
      error,
    );

    const chromeErrorLogPath = path.join(
      userDataDir,
      "chrome-err.log",
    );

    if (fs.existsSync(chromeErrorLogPath)) {
      try {
        console.error(
          "[Chrome] chrome-err.log:",
          fs.readFileSync(
            chromeErrorLogPath,
            "utf8",
          ),
        );
      } catch (logError) {
        console.warn(
          "[Chrome] Erro ao ler chrome-err.log:",
          logError.message,
        );
      }
    }

    try {
      fs.rmSync(
        userDataDir,
        {
          recursive: true,
          force: true,
        },
      );
    } catch (cleanupError) {
      console.warn(
        "[Chrome] Erro ao remover perfil:",
        cleanupError.message,
      );
    }

    throw error;
  }
};

/* ============================================================
   WITH BROWSER
   ============================================================ */

const withBrowser = async (
  callback,
) => {
  /*
   * Impede duas inicializações simultâneas.
   */
  if (!browserLaunchPromise) {
    browserLaunchPromise =
      launchBrowser().finally(
        () => {
          browserLaunchPromise =
            null;
        },
      );
  }

  const {
    browser,
    page,
    userDataDir,
  } =
    await browserLaunchPromise;

  try {
    return await callback(
      page,
      browser,
    );
  } finally {
    try {
      await browser.close();
    } catch (error) {
      console.warn(
        "[Chrome] Erro ao fechar:",
        error.message,
      );
    }

    try {
      fs.rmSync(
        userDataDir,
        {
          recursive: true,
          force: true,
        },
      );
    } catch (error) {
      console.warn(
        "[Chrome] Erro ao remover perfil:",
        error.message,
      );
    }
  }
};

/* ============================================================
   CORS / SEGURANÇA
   ============================================================ */

const hostnameFromHeader = (
  value,
) => {
  if (!value) {
    return "";
  }

  try {
    return new URL(
      value.includes("://")
        ? value
        : `http://${value}`,
    )
      .hostname
      .toLowerCase();
  } catch (error) {
    return "";
  }
};

const isAllowedHostname = (
  hostname,
) => {
  if (!hostname) {
    return false;
  }

  const normalized =
    hostname
      .toLowerCase()
      .replace(
        /^\[|\]$/g,
        "",
      );

  return (
    LOCAL_HOSTS.has(normalized) ||
    normalized === ALLOWED_DOMAIN ||
    normalized.endsWith(
      `.${ALLOWED_DOMAIN}`,
    )
  );
};

app.use(
  (
    req,
    res,
    next,
  ) => {
    const origin =
      req.headers.origin;

    const referer =
      req.headers.referer;

    const requestHost =
      req.headers.host;

    const originHost =
      hostnameFromHeader(
        origin,
      );

    const refererHost =
      hostnameFromHeader(
        referer,
      );

    const host =
      hostnameFromHeader(
        requestHost,
      );

    const allowed = origin
      ? isAllowedHostname(
          originHost,
        )
      : isAllowedHostname(
          refererHost,
        ) ||
        isAllowedHostname(
          host,
        );

    const isLocalRequest =
      !origin &&
      !referer &&
      LOCAL_HOSTS.has(
        hostnameFromHeader(
          requestHost,
        ),
      );

    if (
      !allowed &&
      !isLocalRequest
    ) {
      return res.status(403).json({
        error:
          "Origem nao autorizada",
      });
    }

    if (
      origin &&
      isAllowedHostname(
        originHost,
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        origin,
      );

      res.setHeader(
        "Vary",
        "Origin",
      );
    }

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,OPTIONS",
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization",
    );

    if (
      req.method ===
      "OPTIONS"
    ) {
      return res.sendStatus(
        204,
      );
    }

    return next();
  },
);

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.use(
  "/img",
  express.static(
    path.join(
      __dirname,
      "img",
    ),
    {
      maxAge:
        "1h",
    },
  ),
);

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

const absoluteRequestUrl =
  (
    req,
    pathname,
  ) => {
    const proto =
      req.headers[
        "x-forwarded-proto"
      ] ||
      req.protocol ||
      "https";

    const host =
      req.headers[
        "x-forwarded-host"
      ] ||
      req.headers.host;

    return `${proto}://${host}${pathname}`;
  };

const toHighRes = (
  url,
) => {
  if (!url) {
    return "";
  }

  return url.replace(
    /\/tiny\//g,
    "/head/",
  );
};

const urlToBase64 =
  async (url) => {
    if (!url) {
      return "";
    }

    try {
      const response =
        await axios.get(
          url,
          {
            responseType:
              "arraybuffer",

            timeout: 30000,

            maxContentLength:
              20 *
              1024 *
              1024,

            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36",

              Accept:
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
          },
        );

      const mimeType =
        response.headers[
          "content-type"
        ] ||
        "image/png";

      return `data:${mimeType};base64,${Buffer.from(
        response.data,
      ).toString("base64")}`;
    } catch (error) {
      console.warn(
        "[Image] Falha ao baixar:",
        url,
        error.message,
      );

      return "";
    }
  };

const getBrasiliaDate =
  () => {
    const now =
      new Date();

    return {
      iso:
        now.toISOString(),

      brasilia:
        now.toLocaleString(
          "pt-BR",
          {
            timeZone:
              "America/Sao_Paulo",

            year: "numeric",
            month: "2-digit",
            day: "2-digit",

            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",

            hour12: false,
          },
        ),
    };
  };

/* ============================================================
   TRANSFERMARKT - PARSER
   ============================================================ */

const parseLatestTransfersHtml =
  (
    htmlContent,
    limit = 25,
  ) => {
    const $ =
      cheerio.load(
        htmlContent,
      );

    const absoluteUrl =
      (url) => {
        if (!url) {
          return "";
        }

        try {
          return new URL(
            url,
            TRANSFERMARKT_BASE_URL,
          ).href;
        } catch (error) {
          return "";
        }
      };

    const cleanText =
      (value) =>
        (value || "")
          .replace(
            /\s+/g,
            " ",
          )
          .trim();

    const imageUrl =
      (img) => {
        const src =
          img.attr(
            "data-src",
          ) ||
          img.attr(
            "src",
          ) ||
          "";

        return absoluteUrl(
          src,
        ).replace(
          /\/tiny\//g,
          "/head/",
        );
      };

    const parsePlayer =
      (cell) => {
        const playerLink =
          cell
            .find(
              'td.hauptlink a[href*="/profil/spieler/"]',
            )
            .first();

        const playerUrl =
          absoluteUrl(
            playerLink.attr(
              "href",
            ),
          );

        return {
          name:
            cleanText(
              playerLink.text(),
            ),

          id:
            playerUrl,

          url:
            playerUrl,

          position:
            cleanText(
              cell
                .find(
                  "table.inline-table tr",
                )
                .eq(1)
                .find("td")
                .last()
                .text(),
            ),

          image_url:
            imageUrl(
              cell
                .find("img")
                .first(),
            ),
        };
      };

    const parseClub =
      (cell) => {
        const clubLink =
          cell
            .find(
              'td.hauptlink a[href*="/startseite/verein/"]',
            )
            .first();

        const fallbackClubLink =
          cell
            .find(
              'a[href*="/startseite/verein/"]',
            )
            .first();

        const selectedClubLink =
          clubLink.length
            ? clubLink
            : fallbackClubLink;

        const leagueLink =
          cell
            .find(
              'a[href*="/transfers/wettbewerb/"]',
            )
            .first();

        const clubImg =
          cell
            .find(
              "img.tiny_wappen",
            )
            .first();

        return {
          name:
            cleanText(
              selectedClubLink.text(),
            ) ||
            cleanText(
              clubImg.attr(
                "alt",
              ),
            ),

          full_name:
            cleanText(
              selectedClubLink.attr(
                "title",
              ),
            ) ||
            cleanText(
              clubImg.attr(
                "title",
              ),
            ),

          url:
            absoluteUrl(
              selectedClubLink.attr(
                "href",
              ),
            ),

          image_url:
            imageUrl(
              clubImg,
            ),

          league:
            cleanText(
              leagueLink.text(),
            ),

          league_url:
            absoluteUrl(
              leagueLink.attr(
                "href",
              ),
            ),
        };
      };

    const parseFee =
      (cell) => {
        const feeLink =
          cell
            .find("a")
            .first();

        const value =
          cleanText(
            feeLink.text() ||
              cell.text(),
          );

        return {
          value,

          type:
            value,

          url:
            absoluteUrl(
              feeLink.attr(
                "href",
              ),
            ),
        };
      };

    return $(
      "table.items > tbody > tr",
    )
      .filter(
        (_, row) =>
          $(row)
            .children("td")
            .length >= 6,
      )
      .slice(0, limit)
      .map(
        (_, row) => {
          const cells =
            $(row).children(
              "td",
            );

          const nationalities =
            cells
              .eq(2)
              .find("img")
              .map(
                (__, img) =>
                  cleanText(
                    $(img).attr(
                      "title",
                    ) ||
                      $(img).attr(
                        "alt",
                      ),
                  ),
              )
              .get()
              .filter(Boolean);

          return {
            player:
              parsePlayer(
                cells.eq(0),
              ),

            age:
              cleanText(
                cells
                  .eq(1)
                  .text(),
              ),

            nationalities,

            left:
              parseClub(
                cells.eq(3),
              ),

            joined:
              parseClub(
                cells.eq(4),
              ),

            fee:
              parseFee(
                cells.eq(5),
              ),
          };
        },
      )
      .get();
  };

/* ============================================================
   TRANSFERMARKT - AXIOS
   ============================================================ */

const fetchTransfermarktHtmlWithAxios =
  async () => {
    const response =
      await axios.get(
        TRANSFERMARKT_LATEST_TRANSFERS_URL,
        {
          timeout: 30000,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

            "Accept-Language":
              "en-US,en;q=0.9",

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        },
      );

    return response.data;
  };

/* ============================================================
   TRANSFERMARKT - PUPPETEER
   ============================================================ */

const fetchTransfermarktHtmlWithPuppeteer =
  async () => {
    return withBrowser(
      async (page) => {
        await page.setCacheEnabled(
          false,
        );

        await page.setRequestInterception(
          true,
        );

        page.on(
          "request",
          (request) => {
            const resourceType =
              request.resourceType();

            if (
              [
                "image",
                "media",
                "font",
                "stylesheet",
              ].includes(
                resourceType,
              )
            ) {
              return request.abort();
            }

            return request.continue();
          },
        );

        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
        );

        await page.setExtraHTTPHeaders(
          {
            "accept-language":
              "en-US,en;q=0.9",
          },
        );

        console.log(
          "[Transfermarkt] Abrindo página...",
        );

        await page.goto(
          TRANSFERMARKT_LATEST_TRANSFERS_URL,
          {
            waitUntil:
              "domcontentloaded",

            timeout: 45000,
          },
        );

        try {
          await page.waitForSelector(
            "table.items > tbody > tr",
            {
              timeout: 25000,
            },
          );

          console.log(
            "[Transfermarkt] Tabela encontrada.",
          );
        } catch (error) {
          console.warn(
            "[Transfermarkt] Tabela nao apareceu no tempo limite; tentando analisar HTML recebido.",
          );
        }

        return await page.content();
      },
    );
  };

const describeTransfermarktHtml =
  (htmlContent) => {
    const $ =
      cheerio.load(
        htmlContent || "",
      );

    const title =
      $("title")
        .first()
        .text()
        .replace(
          /\s+/g,
          " ",
        )
        .trim();

    const bodyText =
      $("body")
        .text()
        .replace(
          /\s+/g,
          " ",
        )
        .trim()
        .slice(
          0,
          240,
        );

    return {
      title,
      bodyText,
    };
  };

const fetchTransfermarktPlayerHtml =
  async (
    playerUrl,
  ) => {
    const response =
      await axios.get(
        playerUrl,
        {
          timeout:
            30000,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

            "Accept-Language":
              "en-US,en;q=0.9",

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        },
      );

    return response.data;
  };

const parseFirstGalleryImageUrl =
  (htmlContent) => {
    const $ =
      cheerio.load(
        htmlContent || "",
      );

    const selectors = [
      "swiper-slide.gallery-image img.slider__img",
      "swiper-slide img.slider__img",
      "img.slider__img",
      'img[src*="/foto/galerie/"]',
    ];

    for (const selector of selectors) {
      const element =
        $(selector)
          .first();

      const url =
        element.attr(
          "src",
        ) ||
        element.attr(
          "content",
        ) ||
        "";

      if (url) {
        return absoluteTransfermarktUrl(
          url,
        );
      }
    }

    return "";
  };

const parseFallbackProfileImageUrl =
  (htmlContent) => {
    const $ =
      cheerio.load(
        htmlContent || "",
      );

    const element =
      $(
        'img.spielerbild, meta[property="og:image"]',
      )
        .first();

    const url =
      element.attr(
        "src",
      ) ||
      element.attr(
        "content",
      ) ||
      "";

    return absoluteTransfermarktUrl(
      url,
    );
  };

const fetchTransfermarktPlayerPortraitFromApi =
  async (
    playerId,
    playerUrl,
  ) => {
    const response =
      await axios.get(
        `${TRANSFERMARKT_API_BASE_URL}/players?ids[]=${playerId}`,
        {
          timeout:
            30000,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

            "Accept-Language":
              "en-US,en;q=0.9",

            Origin:
              TRANSFERMARKT_BASE_URL,

            Referer:
              playerUrl,

            Accept:
              "application/json,text/plain,*/*",
          },
        },
      );

    const player =
      response.data?.data?.[0];

    return absoluteTransfermarktUrl(
      player?.portraitUrl || "",
    );
  };

const fetchFirstGalleryImageFromApi =
  async (
    playerId,
    playerUrl,
  ) => {
    const response =
      await axios.get(
        `${TRANSFERMARKT_API_BASE_URL}/player/${playerId}/gallery`,
        {
          timeout:
            30000,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

            "Accept-Language":
              "en-US,en;q=0.9",

            Origin:
              TRANSFERMARKT_BASE_URL,

            Referer:
              playerUrl,

            Accept:
              "application/json,text/plain,*/*",
          },
        },
      );

    const images =
      response.data?.data?.images;

    if (
      !Array.isArray(
        images,
      )
    ) {
      return "";
    }

    const image =
      images.find(
        (item) =>
          typeof item?.url ===
            "string" &&
          item.url.includes(
            "/foto/galerie/",
          ),
      ) ||
      images.find(
        (item) =>
          typeof item?.url ===
          "string",
      );

    return absoluteTransfermarktUrl(
      image?.url || "",
    );
  };

const fetchFirstGalleryImageWithPuppeteer =
  async (
    playerUrl,
  ) => {
    let browser;
    const renderExecutable =
      CHROME_EXECUTABLE ||
      CHROME_HEADLESS_SHELL_EXECUTABLE;

    try {
      const launchOptions = {
        headless:
          "new",

        args:
          PUPPETEER_ARGS,

        defaultViewport: {
          width: 390,
          height: 900,
          deviceScaleFactor: 1,
        },

        timeout:
          60000,
      };

      if (renderExecutable) {
        launchOptions.executablePath =
          renderExecutable;
      }

      browser =
        await puppeteer.launch(
          launchOptions,
        );

      const page =
        await browser.newPage();

      await page.setCacheEnabled(
        false,
      );

      await page.setRequestInterception(
        true,
      );

      page.on(
        "request",
        (request) => {
          const resourceType =
            request.resourceType();

          if (
            [
              "media",
              "font",
            ].includes(
              resourceType,
            )
          ) {
            return request.abort();
          }

          return request.continue();
        },
      );

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      );

      await page.goto(
        playerUrl,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            45000,
        },
      );

      await page.evaluate(
        async () => {
          for (let i = 0; i < 6; i += 1) {
            window.scrollBy(
              0,
              Math.floor(
                window.innerHeight * 0.8,
              ),
            );

            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  500,
                ),
            );
          }

          window.scrollTo(
            0,
            0,
          );
        },
      );

      try {
        await page.waitForSelector(
          'img[src*="/foto/galerie/"]',
          {
            timeout:
              25000,
          },
        );
      } catch (error) {
        return "";
      }

      return await page.$eval(
        'img[src*="/foto/galerie/"]',
        (img) =>
          img.src,
      );
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  };

const mapTransfermarktMarketValueHistory =
  (list) => {
    const clubLogosByClub =
      new Map();

    for (const item of list) {
      const clubName =
        item.verein ||
        "";

      const logo =
        normalizeClubLogoUrl(
          item.wappen,
        );

      if (
        clubName &&
        logo
      ) {
        clubLogosByClub.set(
          clubName,
          logo,
        );
      }
    }

    return list.map(
      (item) => {
        const clubName =
          item.verein ||
          "";

        const logo =
          normalizeClubLogoUrl(
            item.wappen,
          );

        const date =
          item.datum_mw ||
          "";

        const yearMatch =
          date.match(
            /(\d{4})$/,
          );

        return {
          year:
            yearMatch
              ? yearMatch[1]
              : "",

          value:
            formatTransfermarktApiValue(
              item.mw,
            ),

          club_logo_url:
            logo ||
            clubLogosByClub.get(
              clubName,
            ) ||
            "",
        };
      },
    );
  };

const formatTransfermarktNumericMarketValue =
  (value) => {
    const numberValue =
      Number(
        value,
      );

    if (
      !Number.isFinite(
        numberValue,
      ) ||
      numberValue <= 0
    ) {
      return "";
    }

    const euro =
      String.fromCharCode(
        8364,
      );

    if (
      numberValue >=
      1000000
    ) {
      const millions =
        numberValue / 1000000;

      return `${Number.isInteger(
        millions,
      )
        ? millions
        : millions.toFixed(
            1,
          )}M ${euro}`;
    }

    if (
      numberValue >=
      1000
    ) {
      const thousands =
        numberValue / 1000;

      return `${Number.isInteger(
        thousands,
      )
        ? thousands
        : thousands.toFixed(
            1,
          )} mil ${euro}`;
    }

    return `${numberValue} ${euro}`;
  };

const mapTransfermarktMarketValueHistoryFromApi =
  (history) =>
    history.map(
      (item) => {
        const determined =
          item.marketValue?.determined ||
          "";

        return {
          year:
            determined
              ? String(
                  new Date(
                    determined,
                  ).getUTCFullYear(),
                )
              : "",

          value:
            formatTransfermarktNumericMarketValue(
              item.marketValue?.value,
            ),

          club_logo_url:
            item.clubId
              ? `https://img.a.transfermarkt.technology/wappen/medium/${item.clubId}.png`
              : "",
        };
      },
    );

const fetchTransfermarktMarketValueHistoryFromApi =
  async (
    playerId,
    playerUrl,
  ) => {
    const response =
      await axios.get(
        `${TRANSFERMARKT_API_BASE_URL}/player/${playerId}/market-value-history`,
        {
          timeout:
            30000,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

            "Accept-Language":
              "en-US,en;q=0.9",

            Origin:
              TRANSFERMARKT_BASE_URL,

            Referer:
              playerUrl,

            Accept:
              "application/json,text/plain,*/*",
          },
        },
      );

    const history =
      response.data?.data?.history;

    return Array.isArray(
      history,
    )
      ? history
      : [];
  };

const fetchTransfermarktMarketValueListWithPuppeteer =
  async (
    playerId,
    playerUrl,
  ) => {
    let browser;
    const renderExecutable =
      CHROME_EXECUTABLE ||
      CHROME_HEADLESS_SHELL_EXECUTABLE;

    try {
      const launchOptions = {
        headless:
          "new",

        args:
          PUPPETEER_ARGS,

        defaultViewport: {
          width: 390,
          height: 900,
          deviceScaleFactor: 1,
        },

        timeout:
          60000,
      };

      if (renderExecutable) {
        launchOptions.executablePath =
          renderExecutable;
      }

      browser =
        await puppeteer.launch(
          launchOptions,
        );

      const page =
        await browser.newPage();

      await page.setCacheEnabled(
        false,
      );

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      );

      await page.goto(
        playerUrl,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            45000,
        },
      );

      const result =
        await page.evaluate(
          async (id) => {
            const response =
              await fetch(
                `/ceapi/marketValueDevelopment/graph/${id}`,
                {
                  headers: {
                    accept:
                      "application/json,text/plain,*/*",
                  },

                  credentials:
                    "include",
                },
              );

            const text =
              await response.text();

            if (!text) {
              return {
                ok:
                  false,

                status:
                  response.status,

                data:
                  null,
              };
            }

            try {
              return {
                ok:
                  response.ok,

                status:
                  response.status,

                data:
                  JSON.parse(
                    text,
                  ),
              };
            } catch (error) {
              return {
                ok:
                  false,

                status:
                  response.status,

                data:
                  null,

                body:
                  text.slice(
                    0,
                    200,
                  ),
              };
            }
          },
          playerId,
        );

      if (
        !result.ok ||
        !Array.isArray(
          result.data?.list,
        )
      ) {
        console.warn(
          `[Transfermarkt Player] Resposta do navegador sem JSON valido. Status: ${result.status}`,
        );

        if (result.body) {
          console.warn(
            `[Transfermarkt Player] Corpo recebido: ${result.body}`,
          );
        }
      }

      return Array.isArray(
        result.data?.list,
      )
        ? result.data.list
        : [];
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  };

const fetchTransfermarktMarketValueListFromEndpoint =
  async (
    playerId,
    playerUrl,
  ) => {
    const baseUrls =
      [
        new URL(
          playerUrl,
        ).origin,
        ...TRANSFERMARKT_GRAPH_BASE_URLS,
      ].filter(
        (baseUrl, index, list) =>
          baseUrl &&
          list.indexOf(
            baseUrl,
          ) === index,
      );

    for (const baseUrl of baseUrls) {
      const graphUrl =
        `${baseUrl}/ceapi/marketValueDevelopment/graph/${playerId}`;

      try {
        const response =
          await axios.get(
            graphUrl,
            {
              timeout:
                30000,

              validateStatus:
                () => true,

              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",

                "Accept-Language":
                  "en-US,en;q=0.9",

                Referer:
                  playerUrl,

                "X-Requested-With":
                  "XMLHttpRequest",

                Accept:
                  "application/json,text/plain,*/*",
              },
            },
          );

        const list =
          Array.isArray(
            response.data?.list,
          )
            ? response.data.list
            : [];

        if (
          list.length > 0
        ) {
          return list;
        }

        console.warn(
          `[Transfermarkt Player] Endpoint sem historico: ${graphUrl} status ${response.status}`,
        );
      } catch (error) {
        console.warn(
          `[Transfermarkt Player] Falha no endpoint ${graphUrl}:`,
          error.message,
        );
      }
    }

    return [];
  };

const fetchTransfermarktMarketValueHistory =
  async (
    playerId,
    playerUrl,
  ) => {
    try {
      const apiHistory =
        await fetchTransfermarktMarketValueHistoryFromApi(
          playerId,
          playerUrl,
        );

      if (
        apiHistory.length > 0
      ) {
        return mapTransfermarktMarketValueHistoryFromApi(
          apiHistory,
        );
      }

      console.warn(
        "[Transfermarkt Player] API market-value-history retornou vazia; tentando endpoint do grafico.",
      );
    } catch (error) {
      console.warn(
        "[Transfermarkt Player] Falha na API market-value-history:",
        error.message,
      );
    }

    const list =
      await fetchTransfermarktMarketValueListFromEndpoint(
        playerId,
        playerUrl,
      );

    if (
      list.length > 0
    ) {
      return mapTransfermarktMarketValueHistory(
        list,
      );
    }

    console.warn(
      "[Transfermarkt Player] Endpoint JSON retornou vazio; tentando via navegador.",
    );

    const browserList =
      await fetchTransfermarktMarketValueListWithPuppeteer(
        playerId,
        playerUrl,
      );

    return mapTransfermarktMarketValueHistory(
      browserList,
    );
  };

const absoluteTransfermarktUrl =
  (url) => {
    if (!url) {
      return "";
    }

    try {
      return new URL(
        url,
        TRANSFERMARKT_BASE_URL,
      ).href;
    } catch (error) {
      return "";
    }
  };

const extractTransfermarktPlayerId =
  (playerUrl) => {
    if (!playerUrl) {
      return "";
    }

    const match =
      playerUrl.match(
        /\/spieler\/(\d+)/,
      );

    return match
      ? match[1]
      : "";
  };

const isTransfermarktUrl =
  (playerUrl) => {
    try {
      const hostname =
        new URL(
          playerUrl,
        )
          .hostname
          .toLowerCase();

      return (
        hostname ===
          "transfermarkt.com" ||
        hostname.endsWith(
          ".transfermarkt.com",
        )
      );
    } catch (error) {
      return false;
    }
  };

const formatTransfermarktApiValue =
  (value) => {
    if (!value) {
      return "";
    }

    const euro =
      String.fromCharCode(
        8364,
      );

    return value
      .replace(
        new RegExp(
          `^${euro}`,
        ),
        "",
      )
      .replace(
        /\.00m$/i,
        "M",
      )
      .replace(
        /m$/i,
        "M",
      )
      .replace(
        /k$/i,
        " mil",
      )
      .trim() + ` ${euro}`;
  };

const normalizeClubLogoUrl =
  (url) =>
    absoluteTransfermarktUrl(
      url,
    )
      .replace(
        /\/wappen\/profil\//,
        "/wappen/medium/",
      );

/* ============================================================
   SCRAPE
   ============================================================ */

const scrapeLatestTransfers =
  async (limit = 25) => {
    let htmlContent =
      "";

    /*
     * Primeiro tenta Axios.
     */
    try {
      console.log(
        "[Transfermarkt] Tentando Axios...",
      );

      htmlContent =
        await fetchTransfermarktHtmlWithAxios();

      const transfers =
        parseLatestTransfersHtml(
          htmlContent,
          limit,
        );

      if (
        transfers.length > 0
      ) {
        console.log(
          `[Transfermarkt] ${transfers.length} transferências encontradas via Axios.`,
        );

        return transfers;
      }

      console.log(
        "[Transfermarkt] Axios retornou HTML sem transferências.",
      );
    } catch (error) {
      console.warn(
        "[Transfermarkt] Axios falhou:",
        error.message,
      );
    }

    /*
     * Depois tenta Chrome.
     */
    htmlContent =
      await fetchTransfermarktHtmlWithPuppeteer();

    const transfers =
      parseLatestTransfersHtml(
        htmlContent,
        limit,
      );

    if (
      transfers.length === 0
    ) {
      const pageInfo =
        describeTransfermarktHtml(
          htmlContent,
        );

      throw new Error(
        `Transfermarkt nao retornou a tabela de transferencias. Titulo: ${pageInfo.title || "sem titulo"}. Inicio da pagina: ${pageInfo.bodyText || "sem conteudo"}`,
      );
    }

    return transfers;
  };

/* ============================================================
   MARKET VALUE
   ============================================================ */

const formatMarketValue =
  (
    val,
    lang = "pt",
  ) => {
    if (!val) {
      return "";
    }

    let num = null;

    const str =
      val
        .toString()
        .trim()
        .toLowerCase();

    if (
      str.includes("mil") ||
      str.includes("k")
    ) {
      const match =
        str.match(
          /[\d.,]+/,
        );

      if (match) {
        num =
          parseFloat(
            match[0].replace(
              ",",
              ".",
            ),
          ) *
          1000;
      }
    } else if (
      str.includes("mi") ||
      str.includes("m")
    ) {
      const match =
        str.match(
          /[\d.,]+/,
        );

      if (match) {
        num =
          parseFloat(
            match[0].replace(
              ",",
              ".",
            ),
          ) *
          1000000;
      }
    } else {
      const match =
        str.match(
          /[\d.,]+/,
        );

      if (match) {
        num =
          parseFloat(
            match[0].replace(
              ",",
              ".",
            ),
          );
      }
    }

    if (
      num === null ||
      Number.isNaN(num)
    ) {
      return val;
    }

    const symbol = "€";

    let formattedNum =
      "";

    let suffix =
      "";

    if (num >= 1000000) {
      const valM =
        num / 1000000;

      formattedNum =
        Number.isInteger(
          valM,
        )
          ? valM.toString()
          : valM
              .toFixed(1)
              .replace(
                ".",
                ",",
              );

      suffix = "m";
    } else if (
      num >= 1000
    ) {
      const valK =
        num / 1000;

      formattedNum =
        Number.isInteger(
          valK,
        )
          ? valK.toString()
          : valK
              .toFixed(1)
              .replace(
                ".",
                ",",
              );

      suffix = "k";
    } else {
      formattedNum =
        num.toString();
    }

    const langLower =
      lang.toLowerCase();

    if (
      langLower === "en"
    ) {
      formattedNum =
        formattedNum.replace(
          ",",
          ".",
        );

      return `${symbol}${formattedNum}${suffix}`;
    }

    if (
      langLower === "es" ||
      langLower === "pt"
    ) {
      return `${formattedNum}${suffix} ${symbol}`;
    }

    return `${formattedNum}${suffix} ${symbol}`;
  };

/* ============================================================
   MARKET VALUE PARSER
   ============================================================ */

function parseTransfermarktHtml(
  htmlContent,
  lang = "pt",
) {
  if (!htmlContent) {
    return [];
  }

  const $ =
    cheerio.load(
      htmlContent,
    );

  const points = [];

  $("g.chart-dots image").each(
    (i, el) => {
      const href =
        $(el).attr(
          "xlink:href",
        ) ||
        $(el).attr(
          "href",
        );

      if (href) {
        points.push({
          club_logo_url:
            href,
        });
      }
    },
  );

  return points;
}

/* ============================================================
   RENDER HTML -> PNG
   ============================================================ */

const renderImageWithPuppeteer =
  async (
    htmlContent,
  ) => {
    let browser;
    const renderExecutable =
      CHROME_EXECUTABLE ||
      CHROME_HEADLESS_SHELL_EXECUTABLE;

    try {
      console.log(
        "[Render] Executavel:",
        renderExecutable,
      );

      const launchOptions = {
          headless:
            "new",

          args:
            PUPPETEER_ARGS,

          defaultViewport:
            LOW_RESOURCE_VIEWPORT,

          timeout:
            120000,
      };

      if (renderExecutable) {
        launchOptions.executablePath =
          renderExecutable;
      }

      browser =
        await puppeteer.launch(
          launchOptions,
        );

      const page =
        await browser.newPage();

      await page.setCacheEnabled(
        false,
      );

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      );

      await page.setContent(
        htmlContent,
        {
          waitUntil:
            "networkidle0",

          timeout:
            60000,
        },
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            1000,
          ),
      );

      const screenshot =
        await page.screenshot({
        type:
          "png",
      });

      await page.close();

      return screenshot;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  };

/* ============================================================
   PNG -> MP4
   ============================================================ */

const convertImageToMp4 =
  (imageBuffer) =>
    new Promise(
      (
        resolve,
        reject,
      ) => {
        const requestTmpDir =
          fs.mkdtempSync(
            path.join(
              os.tmpdir(),
              "transfer-video-",
            ),
          );

        const imgPath =
          path.join(
            requestTmpDir,
            "card.png",
          );

        const videoOutputPath =
          path.join(
            requestTmpDir,
            "video.mp4",
          );

        const cleanup =
          () => {
            try {
              fs.rmSync(
                requestTmpDir,
                {
                  recursive: true,
                  force: true,
                },
              );
            } catch (error) {
              console.warn(
                "[FFmpeg] Cleanup:",
                error.message,
              );
            }
          };

        try {
          fs.writeFileSync(
            imgPath,
            imageBuffer,
          );
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }

        const duration =
          VIDEO_DURATION_SECONDS;

        const hasLocalAudio =
          fs.existsSync(
            LOCAL_AUDIO_PATH,
          );

        console.log(
          "[FFmpeg] Gerando vídeo...",
        );

        const command =
          ffmpeg()
            .input(imgPath)
            .inputOptions([
              "-loop 1",
              "-t",
              `${duration}`,
            ]);

        if (
          hasLocalAudio
        ) {
          command
            .input(
              LOCAL_AUDIO_PATH,
            )
            .inputOptions([
              "-stream_loop",
              "-1",
            ]);
        }

        command
          .fps(30)

          .videoCodec(
            "libx264",
          )

          .outputOptions([
            "-preset",
            "ultrafast",

            "-threads",
            "1",

            "-crf",
            "28",

            "-pix_fmt",
            "yuv420p",

            "-vf",
            "scale=1080:1920:flags=lanczos",

            "-t",
            `${duration}`,

            "-movflags",
            "+faststart",
          ]);

        if (
          hasLocalAudio
        ) {
          command
            .audioCodec(
              "aac",
            )

            .audioBitrate(
              "96k",
            )

            .audioFilters(
              `volume=${AUDIO_VOLUME}`,
            )

            .outputOptions([
              "-shortest",
            ]);
        }

        command
          .output(
            videoOutputPath,
          )

          .on(
            "start",
            (
              commandLine,
            ) => {
              console.log(
                "[FFmpeg] Command:",
                commandLine,
              );
            },
          )

          .on(
            "stderr",
            (
              stderrLine,
            ) => {
              /*
               * Não loga tudo.
               */
            },
          )

          .on(
            "end",
            () => {
              try {
                const videoBuffer =
                  fs.readFileSync(
                    videoOutputPath,
                  );

                console.log(
                  "[FFmpeg] Vídeo criado.",
                );

                resolve({
                  mime_type:
                    "video/mp4",

                  filename:
                    "reels.mp4",

                  duration_seconds:
                    duration,

                  blob:
                    `data:video/mp4;base64,${videoBuffer.toString(
                      "base64",
                    )}`,
                });
              } catch (error) {
                reject(error);
              } finally {
                cleanup();
              }
            },
          )

          .on(
            "error",
            (err) => {
              console.error(
                "[FFmpeg] Erro:",
                err,
              );

              cleanup();

              reject(err);
            },
          )

          .run();
      },
    );

/* ============================================================
   HTML - TRANSFER CARD
   ============================================================ */

const generateTransferHtml =
  ({
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

<link
  href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&display=swap"
  rel="stylesheet"
>

<style>

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

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
  background: linear-gradient(
    to top,
    rgba(0,0,0,1) 0%,
    rgba(0,0,0,0.85) 50%,
    rgba(0,0,0,0) 100%
  );
  z-index: 3;
}

.watermark-insta {
  position: absolute;
  top: 60px;
  left: 60px;
  color: rgba(255,255,255,0.45);
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
  background: rgba(0,0,0,0.7);
  border: 1px solid rgba(63,158,64,0.5);
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
  background: rgba(18,18,18,0.85);
  border: 1px solid rgba(255,255,255,0.15);
  backdrop-filter: blur(15px);
  padding: 20px 34px;
  border-radius: 16px;
  text-align: center;
  min-width: 310px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
}

.info-card.highlight {
  border-color: #3F9E40;
  background: rgba(63,158,64,0.1);
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
  filter: drop-shadow(
    0 10px 20px rgba(0,0,0,0.8)
  );
}

.handshake-icon {
  width: 92px;
  height: 92px;
  object-fit: contain;
  filter: drop-shadow(
    0 0 20px rgba(63,158,64,0.8)
  );
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

${
  bgB64
    ? `<img class="background-img" src="${bgB64}" />`
    : ""
}

<div class="dark-overlay"></div>

<div class="shadow-overlay"></div>

<div class="watermark-insta">
  ${instagram_handle || ""}
</div>

${
  logoB64
    ? `
<div class="brand-logo-container">
  <div class="logo-bg-wrapper">
    <img
      class="brand-logo"
      src="${logoB64}"
    />
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
  <div class="season-main">
    SEASON ${season}
  </div>

  <div class="season-sub">
    TEMPORADA
  </div>
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

  <div class="info-label">
    MARKET VALUE
  </div>

  <div class="info-sublabel">
    VALOR DE MERCADO
  </div>

  <div class="info-value">
    ${market_value_then}
  </div>

</div>
`
    : ""
}

${
  fee
    ? `
<div class="info-card highlight">

  <div class="info-label">
    TRANSFER FEE
  </div>

  <div class="info-sublabel">
    VALOR DA COMPRA / FICHAJE
  </div>

  <div class="info-value">
    ${fee}
  </div>

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

${
  fromB64
    ? `<img class="badge" src="${fromB64}" />`
    : ""
}

${
  handshakeB64
    ? `<img class="handshake-icon" src="${handshakeB64}" />`
    : ""
}

${
  toB64
    ? `<img class="badge" src="${toB64}" />`
    : ""
}

</div>

<div class="name-banner">

<div class="player-name">
  ${player_name || ""}
  ${player_age ? `(${player_age})` : ""}
</div>

</div>

</body>
</html>
`;

/* ============================================================
   HTML - MARKET VALUE
   ============================================================ */

const generateMarketValueHtml =
  ({
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

<link
  href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&display=swap"
  rel="stylesheet"
>

<style>

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

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
  background: rgba(0,0,0,0.45);
  z-index: 2;
}

.shadow-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 1200px;

  background: linear-gradient(
    to top,
    rgba(0,0,0,1) 0%,
    rgba(0,0,0,0.95) 40%,
    rgba(0,0,0,0.7) 70%,
    rgba(0,0,0,0) 100%
  );

  z-index: 3;
}

.watermark-insta {
  position: absolute;
  top: 60px;
  left: 60px;
  color: rgba(255,255,255,0.45);
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

  box-shadow:
    0 6px 20px rgba(0,0,0,0.7);

  white-space: nowrap;
  text-transform: lowercase;
  letter-spacing: 0.5px;
}

.club-badge {
  width: 140px;
  height: 140px;
  object-fit: contain;

  filter:
    drop-shadow(
      0 10px 20px rgba(0,0,0,0.85)
    );
}

.year-label {
  color: #FFFFFF;
  font-size: 38px;
  font-weight: 900;
  letter-spacing: 1px;

  text-shadow:
    0 4px 10px rgba(0,0,0,0.9);
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

  text-shadow:
    0 4px 20px rgba(0,0,0,0.9);

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

${
  bgB64
    ? `<img class="background-img" src="${bgB64}" />`
    : ""
}

<div class="dark-overlay"></div>

<div class="shadow-overlay"></div>

<div class="watermark-insta">
  ${instagram_handle || ""}
</div>

${
  logoB64
    ? `
<div class="brand-logo-container">

  <div class="logo-bg-wrapper">

    <img
      class="brand-logo"
      src="${logoB64}"
    />

  </div>

</div>
`
    : ""
}

${
  player_name
    ? `
<div class="player-header">

  <div class="player-title">
    ${player_name}
  </div>

  <div class="subtitle-main">
    MARKET VALUE EVOLUTION
  </div>

  <div class="subtitle-sub">
    EVOLUÇÃO DO VALOR DE MERCADO /
    EVOLUCIÓN DEL VALOR DE MERCADO
  </div>

</div>
`
    : ""
}

<div class="timeline-container">

${
  historyWithB64
    .map(
      (item) => `
<div class="timeline-item">

${
  item.formatted_value
    ? `
<div class="value-tag">
  ${item.formatted_value}
</div>
`
    : ""
}

${
  item.club_logo_b64
    ? `
<img
  class="club-badge"
  src="${item.club_logo_b64}"
/>
`
    : ""
}

${
  item.year
    ? `
<div class="year-label">
  ${item.year}
</div>
`
    : ""
}

</div>
`,
    )
    .join("")
}

</div>

</body>
</html>
`;

/* ============================================================
   ROUTE: HEALTH
   ============================================================ */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "fut-ffmpeg",

      chrome:
        CHROME_EXECUTABLE ||
        null,

      port:
        PORT,

      timestamp:
        new Date().toISOString(),
    });
  },
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      chrome:
        CHROME_EXECUTABLE ||
        null,
    });
  },
);

/* ============================================================
   ROUTE: SCRAPE TRANSFERMARKT
   ============================================================ */

app.get(
  "/api/scrape-transfermarkt-transfers",
  async (req, res) => {
    try {
      const limitInput =
        parseInt(
          req.query.limit,
          10,
        );

      const limit =
        Number.isInteger(
          limitInput,
        ) &&
        limitInput > 0
          ? Math.min(
              limitInput,
              100,
            )
          : 25;

      const scraped_at =
        getBrasiliaDate();

      const scrapedTransfers =
        await scrapeLatestTransfers(
          limit,
        );

      const transfers =
        scrapedTransfers.map(
          (transfer) => ({
            ...transfer,

            date:
              scraped_at.brasilia,

            date_iso:
              scraped_at.iso,
          }),
        );

      return res.json({
        source_url:
          TRANSFERMARKT_LATEST_TRANSFERS_URL,

        scraped_at,

        limit,

        count:
          transfers.length,

        transfers,
      });
    } catch (error) {
      console.error(
        "[Scrape] Erro:",
        error,
      );

      return res.status(500).json({
        error:
          "Erro ao fazer scraping dos dados da Transfermarkt",

        details:
          error.message,

        stack:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error.stack,
      });
    }
  },
);

app.post(
  "/api/scrape-transfermarkt-player-market-value",
  async (req, res) => {
    try {
      const {
        player_url,
      } = req.body;

      const playerUrl =
        absoluteTransfermarktUrl(
          player_url,
        );

      const playerId =
        extractTransfermarktPlayerId(
          playerUrl,
        );

      if (
        !playerId ||
        !isTransfermarktUrl(
          playerUrl,
        )
      ) {
        return res.status(400).json({
          error:
            "player_url invalida. Envie uma URL de jogador da Transfermarkt contendo /spieler/{id}.",
        });
      }

      const [
        history,
        profileHtmlResult,
      ] =
        await Promise.allSettled([
          fetchTransfermarktMarketValueHistory(
            playerId,
            playerUrl,
          ),

          fetchTransfermarktPlayerHtml(
            playerUrl,
          ),
        ]);

      if (
        history.status ===
        "rejected"
      ) {
        throw history.reason;
      }

      let galleryImageUrl =
        profileHtmlResult.status ===
        "fulfilled"
          ? parseFirstGalleryImageUrl(
              profileHtmlResult.value,
            )
          : "";

      let fallbackImageUrl =
        profileHtmlResult.status ===
        "fulfilled"
          ? parseFallbackProfileImageUrl(
              profileHtmlResult.value,
            )
          : "";

      if (!fallbackImageUrl) {
        try {
          fallbackImageUrl =
            await fetchTransfermarktPlayerPortraitFromApi(
              playerId,
              playerUrl,
            );
        } catch (error) {
          console.warn(
            "[Transfermarkt Player] Falha ao buscar portrait via API:",
            error.message,
          );
        }
      }

      if (!galleryImageUrl) {
        try {
          galleryImageUrl =
            await fetchFirstGalleryImageFromApi(
              playerId,
              playerUrl,
            );
        } catch (error) {
          console.warn(
            "[Transfermarkt Player] Falha ao buscar galeria via API:",
            error.message,
          );
        }
      }

      if (!galleryImageUrl) {
        try {
          galleryImageUrl =
            await fetchFirstGalleryImageWithPuppeteer(
              playerUrl,
            );
        } catch (error) {
          console.warn(
            "[Transfermarkt Player] Falha ao renderizar galeria:",
            error.message,
          );
        }
      }

      if (
        profileHtmlResult.status ===
        "rejected"
      ) {
        console.warn(
          "[Transfermarkt Player] Falha ao buscar galeria:",
          profileHtmlResult.reason.message,
        );
      }

      const fallbackLocalImageUrl =
        absoluteRequestUrl(
          req,
          FALLBACK_PLAYER_IMAGE_PATH,
        );

      const historyValue =
        history.value;

      const responsePayload = {
        player_url:
          playerUrl,

        player_id:
          playerId,

        gallery_image_url:
          galleryImageUrl ||
          fallbackLocalImageUrl,

        image_url:
          fallbackImageUrl ||
          galleryImageUrl ||
          fallbackLocalImageUrl,

        history_count:
          historyValue.length,

        history_packed:
          packMarketValueHistory(
            historyValue,
          ),
      };

      if (
        req.body.include_history ===
          true ||
        req.query.include_history ===
          "true"
      ) {
        responsePayload.history =
          historyValue;
      }

      return res.json(
        responsePayload,
      );
    } catch (error) {
      console.error(
        "[Transfermarkt Player] Erro:",
        error,
      );

      return res.status(500).json({
        error:
          "Erro ao buscar historico de valor de mercado do jogador",

        details:
          error.message,

        stack:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error.stack,
      });
    }
  },
);

/* ============================================================
   ROUTE: GENERATE TRANSFER CARD
   ============================================================ */

app.post(
  "/api/generate-transfer-card",
  async (req, res) => {
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

        logo_url =
          "https://futebolnatv.info/assets/logo/logo_green.png",

        handshake_icon_url,

        instagram_handle =
          "@futebolnatv.info",
      } = req.body;

      console.log(
        "[Transfer Card] Iniciando geração...",
      );

      const [
        bgB64,
        playerB64,
        fromB64,
        toB64,
        handshakeB64,
        logoB64,
      ] =
        await Promise.all([
          urlToBase64(
            toHighRes(
              background_image_url,
            ),
          ),

          urlToBase64(
            toHighRes(
              player_image_url,
            ),
          ),

          urlToBase64(
            toHighRes(
              from_team_url,
            ),
          ),

          urlToBase64(
            toHighRes(
              to_team_url,
            ),
          ),

          urlToBase64(
            toHighRes(
              handshake_icon_url,
            ),
          ),

          urlToBase64(
            logo_url,
          ),
        ]);

      /*
       * Mantém compatibilidade com o payload.
       */
      void playerB64;

      const htmlContent =
        generateTransferHtml({
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

      console.log(
        "[Transfer Card] Renderizando PNG...",
      );

      const imageBuffer =
        await renderImageWithPuppeteer(
          htmlContent,
        );

      console.log(
        "[Transfer Card] Convertendo para MP4...",
      );

      const video =
        await convertImageToMp4(
          imageBuffer,
        );

      console.log(
        "[Transfer Card] Finalizado.",
      );

      return res.json(
        video,
      );
    } catch (error) {
      console.error(
        "[Transfer Card] Error:",
        error,
      );

      return res.status(500).json({
        error:
          error.message,

        details:
          error.stack,
      });
    }
  },
);

/* ============================================================
   ROUTE: GENERATE MARKET VALUE CARD
   ============================================================ */

app.post(
  "/api/generate-market-value-card",
  async (req, res) => {
    try {
      const {
        player_name,

        background_image_url,

        logo_url =
          "https://futebolnatv.info/assets/logo/logo_green.png",

        instagram_handle =
          "@futebolnatv.info",

        lang = "pt",

        transfermarkt_html,

        history_packed,

        history = [],
      } = req.body;

      console.log(
        "[Market Value] Iniciando geração...",
      );

      let marketHistory =
        history_packed
          ? unpackMarketValueHistory(
              history_packed,
            )
          : [
              ...(
                Array.isArray(
                  history,
                )
                  ? history
                  : []
              ),
            ];

      /*
       * Se não vier history mas vier HTML,
       * tenta extrair os clubes.
       */
      if (
        transfermarkt_html &&
        marketHistory.length === 0
      ) {
        const parsedClubs =
          parseTransfermarktHtml(
            transfermarkt_html,
            lang,
          );

        marketHistory =
          parsedClubs.map(
            (
              item,
              index,
            ) => ({
              year:
                item.year ||
                `202${index + 1}`,

              value:
                item.value ||
                "500 mil €",

              club_logo_url:
                item.club_logo_url,
            }),
          );
      }

      /*
       * Ordena por ano.
       */
      marketHistory.sort(
        (
          a,
          b,
        ) => {
          const yearA =
            parseInt(
              a.year,
              10,
            ) || 0;

          const yearB =
            parseInt(
              b.year,
              10,
            ) || 0;

          return (
            yearA -
            yearB
          );
        },
      );

      const [
        bgB64,
        logoB64,
      ] =
        await Promise.all([
          urlToBase64(
            background_image_url,
          ),

          urlToBase64(
            logo_url,
          ),
        ]);

      const historyWithB64 =
        await Promise.all(
          marketHistory.map(
            async (
              item,
            ) => ({
              ...item,

              formatted_value:
                formatMarketValue(
                  item.value,
                  lang,
                ),

              club_logo_b64:
                await urlToBase64(
                  item.club_logo_url,
                ),
            }),
          ),
        );

      const htmlContent =
        generateMarketValueHtml({
          player_name,

          bgB64,

          logoB64,

          instagram_handle,

          historyWithB64,

          lang,
        });

      console.log(
        "[Market Value] Renderizando PNG...",
      );

      const imageBuffer =
        await renderImageWithPuppeteer(
          htmlContent,
        );

      console.log(
        "[Market Value] Convertendo para MP4...",
      );

      const video =
        await convertImageToMp4(
          imageBuffer,
        );

      console.log(
        "[Market Value] Finalizado.",
      );

      return res.json(
        video,
      );
    } catch (error) {
      console.error(
        "[Market Value] Error:",
        error,
      );

      return res.status(500).json({
        error:
          error.message,

        details:
          error.stack,
      });
    }
  },
);

/* ============================================================
   ERROR HANDLER
   ============================================================ */

app.use(
  (
    error,
    req,
    res,
    next,
  ) => {
    console.error(
      "[Express] Erro não tratado:",
      error,
    );

    if (
      res.headersSent
    ) {
      return next(
        error,
      );
    }

    return res.status(500).json({
      error:
        error.message ||
        "Internal server error",
    });
  },
);

/* ============================================================
   START SERVER
   ============================================================ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");

    console.log(
      "==========================================",
    );

    console.log(
      " FUT-FFMPEG SERVER",
    );

    console.log(
      "==========================================",
    );

    console.log(
      `Porta: ${PORT}`,
    );

    console.log(
      `URL interna: http://0.0.0.0:${PORT}`,
    );

    console.log(
      `Chrome: ${
        CHROME_EXECUTABLE ||
        "NÃO ENCONTRADO"
      }`,
    );

    console.log(
      "==========================================",
    );

    console.log("");
  },
);
