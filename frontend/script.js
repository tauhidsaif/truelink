// =============================
// File: frontend/script.js
// =============================

// -----------------------------
// Utility helper
// -----------------------------
function el(id) {
  return document.getElementById(id);
}

// -----------------------------
// Copy text to clipboard
// -----------------------------
async function copyText(text, btn) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    // UI feedback
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1200);
  } catch (err) {
    alert("Failed to copy: " + err);
  }
}

// -----------------------------
// Create short link
// -----------------------------
async function createLink() {
  const longUrl = el("urlInput").value.trim();
  if (!longUrl) {
    alert("Enter a URL");
    return;
  }

  // Basic validation
  if (!/^https?:\/\//i.test(longUrl)) {
    alert("Invalid URL (must start with http:// or https://)");
    return;
  }

  try {
    const res = await fetch("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: longUrl }),
    });

    if (!res.ok) throw new Error("Request failed");

    const data = await res.json();
    const shortUrl =
      window.location.protocol + "//" + window.location.host + "/r/" + data.slug;

    // Update UI
    el("resultBox").classList.remove("hidden");
    el("shortLink").href = shortUrl;
    el("shortLink").textContent = shortUrl;

    // Clear QR and regenerate (responsive)
    el("qrBox").innerHTML = "";
    new QRCode(el("qrBox"), {
      text: shortUrl,
      width: 160,
      height: 160,
    });
    el("qrBox").querySelector("img").style.maxWidth = "100%";

    loadRecent();
  } catch (err) {
    alert("Failed to create: " + err.message);
  }
}

// -----------------------------
// Load recent links
// -----------------------------
async function loadRecent() {
  try {
    const res = await fetch("/recent");
    if (!res.ok) throw new Error("Fetch failed");

    const data = await res.json();
    const box = el("recent");
    box.innerHTML = "";

    if (!data.links || data.links.length === 0) {
      box.innerHTML =
        "<p class='text-gray-500 italic'>No recent links yet.</p>";
      return;
    }

    data.links.forEach((l) => {
      const shortUrl =
        window.location.protocol + "//" + window.location.host + "/r/" + l.slug;

      const div = document.createElement("div");
      div.className =
        "flex items-center justify-between bg-gray-50 dark:bg-gray-700 rounded-xl px-3 py-2";

      div.innerHTML = `
        <a href="${shortUrl}" target="_blank" class="truncate text-blue-600 dark:text-blue-400">
          ${shortUrl}
        </a>
        <div class="flex gap-2 ml-2 flex-shrink-0">
          <button class="text-sm bg-gray-200 dark:bg-gray-600 px-2 py-1 rounded copyBtn">Copy</button>
          <a href="${shortUrl}" target="_blank" class="text-sm bg-blue-500 text-white px-2 py-1 rounded">Open</a>
        </div>
      `;

      // Attach copy handler
      div.querySelector(".copyBtn").addEventListener("click", (e) =>
        copyText(shortUrl, e.target)
      );

      box.appendChild(div);
    });
  } catch (err) {
    el("recent").innerHTML =
      "<p class='text-red-500 italic'>Failed to load recent links.</p>";
    console.error(err);
  }
}

// -----------------------------
// Init
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Handle form submit (Enter key)
  const form = el("formCreate");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      createLink();
    });
  }

  // Handle button click
  el("btnGen").addEventListener("click", createLink);

  // Handle copy of current link
  el("btnCopy").addEventListener("click", () => {
    const link = el("shortLink").textContent;
    if (link) copyText(link, el("btnCopy"));
  });

  loadRecent();
});
