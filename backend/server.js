// =============================
// File: backend/server.js
// =============================
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Let Express trust reverse proxies (needed to read X-Forwarded-* correctly)
app.set("trust proxy", true);

// In-memory store (replace with DB for production)
const linkStore = {};
const permanentLinks = {};

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend"))); // serve frontend files

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// --- helpers ---
function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function generateId(n = 4) {
  return crypto.randomBytes(n).toString("base64url").slice(0, n + 2);
}

function getOrigin(req) {
  // Prefer forwarded headers when behind a proxy (Vercel, Render, etc.)
  const proto =
    (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function detectApp(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("youtube.com") || host === "youtu.be")
      return { app: "youtube", meta: { u } };
    if (host === "wa.me" || host.includes("whatsapp.com"))
      return { app: "whatsapp", meta: { u } };
    if (host === "t.me" || host.includes("telegram.me") || host.includes("telegram.org"))
      return { app: "telegram", meta: { u } };
    if (host.includes("instagram.com"))
      return { app: "instagram", meta: { u } };
    if (host.startsWith("amazon.") || host.includes("amazon."))
      return { app: "amazon", meta: { u } };
    if (host.includes("twitter.com") || host.includes("x.com"))
      return { app: "twitter", meta: { u } };
    if (host.includes("facebook.com"))
      return { app: "facebook", meta: { u } };
    return { app: null, meta: { u } };
  } catch (e) {
    return { app: null, meta: {} };
  }
}

function buildChromeScheme(fallbackHttps) {
  // e.g. https://example.com/path -> googlechrome://example.com/path
  return `googlechrome://${fallbackHttps.replace(/^https?:\/\//, "")}`;
}

// Build a best-effort deep link.
// Strategy:
//  - Android: use intent:// + package + S.browser_fallback_url=HTTPS (never app schemes)
//  - iOS: use custom schemes where reliable; otherwise just use HTTPS (App Links)
//  - Give a visible "Open in Chrome" link using googlechrome:// as an *optional* tap target.
function buildDeepLink(urlStr, userAgent) {
  const { app, meta } = detectApp(urlStr);
  const u = meta.u;
  const fallbackHttps = urlStr; // must be http/https
  const chromeScheme = buildChromeScheme(fallbackHttps);

  let ios = null;
  let androidIntent = null;

  const encFB = encodeURIComponent(fallbackHttps);

  const asHostPath = (urlObj) =>
    `${urlObj.hostname}${urlObj.pathname}${urlObj.search}${urlObj.hash || ""}`;

  switch (app) {
    case "youtube": {
      // Normalize youtu.be to a proper watch URL for intents
      let vId = u.searchParams.get("v");
      if (!vId && u.hostname === "youtu.be") vId = u.pathname.slice(1);

      // iOS scheme
      ios = vId ? `youtube://watch?v=${vId}` : `youtube://`;

      // Android intent with HTTPS host/path and explicit package
      const hostPath = vId
        ? `www.youtube.com/watch?v=${encodeURIComponent(vId)}`
        : asHostPath(new URL(`https://www.youtube.com`));
      androidIntent = `intent://${hostPath}#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=${encFB};end`;
      break;
    }

    case "whatsapp": {
      // Extract phone/text from wa.me or web URLs
      const pathDigits = u.pathname.replace(/^\/send\/?/, "").replace(/\//g, "");
      const phone = u.searchParams.get("phone") || (/^\d{6,15}$/.test(pathDigits) ? pathDigits : "");
      const text = u.searchParams.get("text") || "";

      const qp = new URLSearchParams();
      if (phone) qp.set("phone", phone);
      if (text) qp.set("text", text);

      const q = qp.toString();
      ios = q ? `whatsapp://send?${q}` : `whatsapp://send`;
      androidIntent = `intent://send${q ? `?${q}` : ""}#Intent;scheme=whatsapp;package=com.whatsapp;S.browser_fallback_url=${encFB};end`;
      break;
    }

    case "telegram": {
      // Try to resolve username: t.me/<name>
      // For more complex paths (joinchat/c/…), fallback to HTTPS which uses App Links.
      const path = u.pathname.replace(/^\//, "");
      const userMatch = path.match(/^([A-Za-z0-9_]{5,32})$/);
      if (userMatch) {
        ios = `tg://resolve?domain=${userMatch[1]}`;
      } else {
        ios = null; // fallback to https (App Links handle many cases)
      }
      const hostPath = asHostPath(u);
      androidIntent = `intent://${hostPath}#Intent;scheme=https;package=org.telegram.messenger;S.browser_fallback_url=${encFB};end`;
      break;
    }

    case "instagram": {
      // iOS: profile deep link only (post by shortcode needs numeric media id which we don't have)
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] && parts[0] !== "p") {
        ios = `instagram://user?username=${encodeURIComponent(parts[0])}`;
      } else {
        ios = `instagram://`; // open app; exact post open not reliable via scheme
      }
      const hostPath = asHostPath(u);
      androidIntent = `intent://${hostPath}#Intent;scheme=https;package=com.instagram.android;S.browser_fallback_url=${encFB};end`;
      break;
    }

    case "amazon": {
      ios = `amazon://`;
      const hostPath = asHostPath(u);
      androidIntent = `intent://${hostPath}#Intent;scheme=https;package=com.amazon.mShop.android.shopping;S.browser_fallback_url=${encFB};end`;
      break;
    }

    case "twitter": {
      // Handle x.com or twitter.com
      // iOS scheme (if we have a numeric status id)
      let iosScheme = `twitter://`;
      const statusIdMatch = u.pathname.match(/\/status\/(\d+)/); // /<user>/status/<id>
      if (statusIdMatch) {
        iosScheme = `twitter://status?id=${statusIdMatch[1]}`;
      }
      ios = iosScheme;

      const hostPath = asHostPath(u);
      androidIntent = `intent://${hostPath}#Intent;scheme=https;package=com.twitter.android;S.browser_fallback_url=${encFB};end`;
      break;
    }

    case "facebook": {
      ios = `fb://`;
      const hostPath = asHostPath(u);
      androidIntent = `intent://${hostPath}#Intent;scheme=https;package=com.facebook.katana;S.browser_fallback_url=${encFB};end`;
      break;
    }

    default: {
      // Generic: try to open via Android intent to system handler, fall back to HTTPS.
      const hostPath = asHostPath(u);
      androidIntent = `intent://${hostPath}#Intent;scheme=${u.protocol.replace(":", "")};S.browser_fallback_url=${encFB};end`;
      ios = null; // iOS will use HTTPS fallback
    }
  }

  return { ios, androidIntent, fallbackHttps, chromeScheme };
}

// --- API: create short link ---
app.post("/api/create", (req, res) => {
  const { url, slug } = req.body || {};
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ ok: false, error: "Valid URL is required (http/https)." });
  }

  let id = (slug || "").trim();
  if (id) {
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(id)) {
      return res.status(400).json({ ok: false, error: "Slug must be 3-32 chars (a-z, 0-9, -, _)." });
    }
    if (linkStore[id] || permanentLinks[id]) {
      return res.status(409).json({ ok: false, error: "Slug already in use." });
    }
  } else {
    do { id = generateId(3); } while (linkStore[id] || permanentLinks[id]);
  }

  const data = { url, slug: id, createdAt: Date.now() };
  permanentLinks[id] = data;
  linkStore[id] = data;

  const origin = getOrigin(req);
  return res.json({ ok: true, id, shortUrl: `${origin}/r/${id}` });
});

// --- API: list recent (for UI) ---
app.get("/api/links", (req, res) => {
  const rows = Object.entries(permanentLinks)
    .map(([id, v]) => ({ id, url: v.url, createdAt: v.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
  res.json({ ok: true, rows });
});

// --- Redirect handler ---
app.get("/r/:id", (req, res) => {
  const item = permanentLinks[req.params.id];
  if (!item) return res.status(404).send("Link not found");

  const { ios, androidIntent, fallbackHttps, chromeScheme } = buildDeepLink(
    item.url,
    req.headers["user-agent"] || ""
  );

  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Opening app…</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;line-height:1.45}
    a{word-break:break-all}
  </style>
</head>
<body>
  <h2>Opening the app…</h2>
  <p>If nothing happens, it will open in your browser. You can also <a id="openChrome" href="${chromeScheme}" rel="noopener noreferrer">open in Chrome</a>.</p>
  <script>
    (function(){
      var ua = navigator.userAgent || navigator.vendor || window.opera;
      var isAndroid = /android/i.test(ua);
      var isIOS = /iPhone|iPad|iPod/i.test(ua);

      var intentUrl = ${JSON.stringify(androidIntent)};
      var iosUrl = ${JSON.stringify(ios)};
      var httpsFallback = ${JSON.stringify(fallbackHttps)};
      var chromeScheme = ${JSON.stringify(chromeScheme)};

      function go(href){ if (href) window.location.href = href; }

      if (isAndroid) {
        // App first (intent), then HTTPS (never app-scheme), user can tap "Open in Chrome" manually
        go(intentUrl);
        setTimeout(function(){ go(httpsFallback); }, 1200);
      } else if (isIOS) {
        // Try iOS scheme if we have one, then try Chrome (if installed), then HTTPS
        var triedScheme = false;
        if (iosUrl) {
          triedScheme = true;
          go(iosUrl);
        }
        setTimeout(function(){
          // Attempt Chrome next (will noop if not installed)
          go(chromeScheme);
          setTimeout(function(){ go(httpsFallback); }, 900);
        }, triedScheme ? 700 : 0);
      } else {
        // Desktop: just open HTTPS immediately (Chrome link is visible as an option)
        go(httpsFallback);
      }
    })();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
