// =============================
// File: backend/server.js
// =============================
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// In-memory store (replace with DB for production)
// shape: { [id]: { url, slug, createdAt } }
const linkStore = {};

app.use(express.json());

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

function detectApp(urlStr) {
  // returns { app: 'youtube'|'whatsapp'|'telegram'|'instagram'|'amazon'|'twitter'|'facebook'|null, meta }
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("youtube.com") || host === "youtu.be") return { app: "youtube", meta: { u } };
    if (host.includes("whatsapp.com") || host === "wa.me") return { app: "whatsapp", meta: { u } };
    if (host.includes("t.me") || host.includes("telegram.me") || host.includes("telegram.org")) return { app: "telegram", meta: { u } };
    if (host.includes("instagram.com")) return { app: "instagram", meta: { u } };
    if (host.includes("amazon.")) return { app: "amazon", meta: { u } };
    if (host.includes("twitter.com") || host.includes("x.com")) return { app: "twitter", meta: { u } };
    if (host.includes("facebook.com")) return { app: "facebook", meta: { u } };
    return { app: null, meta: { u } };
  } catch (e) {
    return { app: null, meta: {} };
  }
}

function buildDeepLink(urlStr, userAgent) {
  // returns { ios, androidIntent, fallback }
  const { app, meta } = detectApp(urlStr);
  const fallback = urlStr;
  let ios = null;
  let androidIntent = null;

  const u = meta.u;

  switch (app) {
    case "youtube": {
      // Try to extract video id
      let vId = u.searchParams.get("v");
      if (!vId && u.hostname === "youtu.be") vId = u.pathname.slice(1);
      // iOS scheme
      if (vId) ios = `youtube://watch?v=${vId}`; else ios = `youtube://`;
      // Android intent with package + browser fallback
      const fb = encodeURIComponent(fallback);
      if (vId) {
        androidIntent = `intent://watch?v=${vId}#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=${fb};end`;
      } else {
        androidIntent = `intent://#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=${fb};end`;
      }
      break;
    }
    case "whatsapp": {
      // Preserve text/phone params
      let waPath = "send";
      const text = u.searchParams.get("text");
      const phone = u.searchParams.get("phone") || u.pathname.replace("/send/", "").replace("/", "");
      const qp = new URLSearchParams();
      if (phone) qp.set("phone", phone);
      if (text) qp.set("text", text);
      const q = qp.toString();
      ios = q ? `whatsapp://send?${q}` : `whatsapp://send`;
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://${waPath}${q ? `?${q}` : ""}#Intent;scheme=whatsapp;package=com.whatsapp;S.browser_fallback_url=${fb};end`;
      break;
    }
    case "telegram": {
      // t.me/<username>
      const path = u.pathname.replace(/^\//, "");
      ios = `tg://resolve?domain=${path}`;
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://${path}#Intent;scheme=tg;package=org.telegram.messenger;S.browser_fallback_url=${fb};end`;
      break;
    }
    case "instagram": {
      // instagram.com/<user> or /p/<code>
      const path = u.pathname;
      ios = `instagram://${path.startsWith("/p/") ? `media?id=${path.split("/")[2]}` : `user?username=${path.split("/")[1] || ""}`}`;
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://${path.replace(/^\//, "")}#Intent;scheme=instagram;package=com.instagram.android;S.browser_fallback_url=${fb};end`;
      break;
    }
    case "amazon": {
      ios = `amazon://`;
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://#Intent;scheme=amazon;package=com.amazon.mShop.android.shopping;S.browser_fallback_url=${fb};end`;
      break;
    }
    case "twitter": {
      // x.com/twitter.com links → twitter://
      const path = u.pathname;
      ios = `twitter://` + (path.startsWith("/status/") ? `status?id=${path.split("/")[3] || ""}` : ``);
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://${path.replace(/^\//, "")}#Intent;scheme=twitter;package=com.twitter.android;S.browser_fallback_url=${fb};end`;
      break;
    }
    case "facebook": {
      ios = `fb://`;
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://#Intent;scheme=fb;package=com.facebook.katana;S.browser_fallback_url=${fb};end`;
      break;
    }
    default: {
      // Generic behavior
      const fb = encodeURIComponent(fallback);
      androidIntent = `intent://${fallback.replace(/^https?:\/\//, "")}#Intent;scheme=https;S.browser_fallback_url=${fb};end`;
      ios = null;
    }
  }

  return { ios, androidIntent, fallback };
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
    if (linkStore[id]) {
      return res.status(409).json({ ok: false, error: "Slug already in use." });
    }
  } else {
    do { id = generateId(3); } while (linkStore[id]);
  }

  linkStore[id] = { url, slug: id, createdAt: Date.now() };
  return res.json({ ok: true, id, shortUrl: `http://localhost:${PORT}/r/${id}` });
});

// --- API: list recent (for UI) ---
app.get("/api/links", (req, res) => {
  const rows = Object.entries(linkStore)
    .map(([id, v]) => ({ id, url: v.url, createdAt: v.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
  res.json({ ok: true, rows });
});

// --- Redirect handler ---
app.get("/r/:id", (req, res) => {
  const item = linkStore[req.params.id];
  if (!item) return res.status(404).send("Link not found");

  const { ios, androidIntent, fallback } = buildDeepLink(item.url, req.headers["user-agent"] || "");

  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Opening app…</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;line-height:1.4}</style>
</head>
<body>
  <h2>Opening the app…</h2>
  <p>If nothing happens, <a id="fallback" href="${fallback}">tap here</a>.</p>
  <script>
    (function(){
      var ua = navigator.userAgent || navigator.vendor || window.opera;
      var isAndroid = /android/i.test(ua);
      var isIOS = /iPhone|iPad|iPod/i.test(ua);

      function go(href){ if (href) window.location.href = href; }

      if (isAndroid) {
        go(${JSON.stringify(androidIntent)});
        setTimeout(function(){ go(${JSON.stringify(fallback)}); }, 1600);
      } else if (isIOS) {
        // Try app scheme first (if available), then web fallback
        var iosUrl = ${JSON.stringify(ios)};
        if (iosUrl) { go(iosUrl); }
        setTimeout(function(){ go(${JSON.stringify(fallback)}); }, 1200);
      } else {
        go(${JSON.stringify(fallback)});
      }
    })();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});


