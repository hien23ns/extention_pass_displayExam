/* ─── Element refs ─────────────────────────────────────── */
const enabled             = document.getElementById("enabled");
const autoWayground       = document.getElementById("autoWayground");
const modeFast            = document.getElementById("modeFast");
const modeAccurate        = document.getElementById("modeAccurate");
const status              = document.getElementById("status");
const answer              = document.getElementById("answer");
const answerHint          = document.getElementById("answerHint");
const answerDetail        = document.getElementById("answerDetail");
const errorBox            = document.getElementById("error");

const themeToggle         = document.getElementById("themeToggle");
const iconMoon            = document.getElementById("iconMoon");
const iconSun             = document.getElementById("iconSun");

const apiKeyInput         = document.getElementById("apiKeyInput");
const toggleKeyVisibility = document.getElementById("toggleKeyVisibility");
const saveApiKey          = document.getElementById("saveApiKey");
const testApiKey          = document.getElementById("testApiKey");
const apiKeyStatus        = document.getElementById("apiKeyStatus");
const openAiStudio        = document.getElementById("openAiStudio");

/* ─── Theme ────────────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const isDark = theme !== "light";
  iconMoon.hidden = !isDark;
  iconSun.hidden  = isDark;
  themeToggle.title       = isDark ? "Chuyển sang sáng" : "Chuyển sang tối";
  themeToggle.ariaLabel   = isDark ? "Chuyển sang sáng" : "Chuyển sang tối";
}

themeToggle.onclick = async () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next    = current === "light" ? "dark" : "light";
  applyTheme(next);
  await chrome.storage.local.set({ quizPeekTheme: next });
};

/* ─── Status & Errors ──────────────────────────────────── */
function renderStatus() {
  const isEnabled = enabled.getAttribute("aria-checked") === "true";
  const isAuto    = autoWayground.getAttribute("aria-checked") === "true";

  enabled.setAttribute("aria-checked", String(isEnabled));
  autoWayground.setAttribute("aria-checked", String(isAuto));

  status.textContent = isEnabled ? "Sẵn sàng" : "Đã tắt";
  status.style.color = isEnabled ? "var(--green)" : "var(--text-muted)";
  const dot = document.querySelector(".status-pulse-dot");
  if (dot) {
    dot.style.background = isEnabled ? "var(--green)" : "var(--text-dim)";
    dot.style.boxShadow  = isEnabled ? "0 0 6px var(--green)" : "none";
    dot.style.animation  = isEnabled ? "pulseDot 2s infinite ease-in-out" : "none";
  }
  autoWayground.disabled = !isEnabled;

  enabled.classList.toggle("is-on", isEnabled);
  autoWayground.classList.toggle("is-on", isAuto);
}

function showError(message) {
  errorBox.textContent = message || "";
}

function renderAnswerValue(value) {
  const text = String(value ?? "—");
  answer.textContent = text;
  answer.classList.toggle("answer-loading", text === "...");
  answer.classList.toggle("answer-unknown", text.trim() === "?");
}

function renderAnswerMode(mode) {
  const isAccurate = mode === "accurate";
  modeFast.checked = !isAccurate;
  modeAccurate.checked = isAccurate;
  modeFast.closest(".mode-radio").classList.toggle("is-selected", !isAccurate);
  modeAccurate.closest(".mode-radio").classList.toggle("is-selected", isAccurate);
}

async function setAnswerMode(mode) {
  const answerMode = mode === "accurate" ? "accurate" : "fast";
  await chrome.storage.local.set({ answerMode });
  renderAnswerMode(answerMode);
}

/* ─── API Key Management ───────────────────────────────── */
function renderApiKeyStatus(state, message) {
  apiKeyStatus.className = "api-status-banner";
  if (state === "valid") {
    apiKeyStatus.classList.add("is-valid");
    apiKeyStatus.innerHTML = `<span>🟢 ${message || "Đã kết nối Gemini API thành công!"}</span>`;
  } else if (state === "invalid") {
    apiKeyStatus.classList.add("is-invalid");
    apiKeyStatus.innerHTML = `<span>⚠️ ${message || "API Key chưa đúng hoặc lỗi mạng"}</span>`;
  } else if (state === "loading") {
    apiKeyStatus.innerHTML = `<span>⏳ ${message || "Đang kiểm tra API Key..."}</span>`;
  } else {
    apiKeyStatus.innerHTML = `<span>ℹ️ Chưa cấu hình API Key. Dán key vào và bấm Lưu Key!</span>`;
  }
}

async function verifyApiKey(key) {
  const currentKey = (key || "").trim();
  if (!currentKey) {
    renderApiKeyStatus("none");
    return;
  }

  renderApiKeyStatus("loading", "Đang kết nối Gemini API...");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "TEST_API_KEY",
      apiKey: currentKey
    });

    if (res?.ok) {
      renderApiKeyStatus("valid", `Gemini API đã kết nối sẵn sàng (${res.model || "3.8 Flash"})!`);
    } else {
      renderApiKeyStatus("invalid", res?.error || "Key không hoạt động");
    }
  } catch (e) {
    renderApiKeyStatus("invalid", "Không kiểm tra được: " + e.message);
  }
}

saveApiKey.onclick = async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showError("Vui lòng dán mã API Key trước khi bấm lưu.");
    return;
  }
  showError("");
  await chrome.storage.local.set({ geminiApiKey: key });
  await verifyApiKey(key);
};

testApiKey.onclick = async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showError("Vui lòng nhập API Key để kiểm tra.");
    return;
  }
  showError("");
  await verifyApiKey(key);
};

toggleKeyVisibility.onclick = () => {
  if (apiKeyInput.type === "password") {
    apiKeyInput.type = "text";
  } else {
    apiKeyInput.type = "password";
  }
};

openAiStudio.onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://aistudio.google.com/app/apikey" });
};

/* ─── Event: Power toggle ──────────────────────────────── */
enabled.onclick = async () => {
  const next = enabled.getAttribute("aria-checked") !== "true";
  enabled.setAttribute("aria-checked", String(next));
  await chrome.storage.local.set({ enabled: next });

  if (!next) {
    await chrome.storage.local.set({ autoWayground: false });
    autoWayground.setAttribute("aria-checked", "false");
    await chrome.runtime.sendMessage({ type: "SET_AUTO_WAYGROUND", enabled: false });
  }

  renderStatus();
};

/* ─── Event: Auto Wayground toggle ────────────────────── */
autoWayground.onclick = async () => {
  if (enabled.getAttribute("aria-checked") !== "true") return;

  const next = autoWayground.getAttribute("aria-checked") !== "true";
  autoWayground.setAttribute("aria-checked", String(next));
  await chrome.storage.local.set({ autoWayground: next });
  await chrome.runtime.sendMessage({ type: "SET_AUTO_WAYGROUND", enabled: next });
  renderStatus();
};

/* ─── Event: Answer mode ───────────────────────────────── */
modeFast.onchange = () => {
  if (modeFast.checked) setAnswerMode("fast");
};
modeAccurate.onchange = () => {
  if (modeAccurate.checked) setAnswerMode("accurate");
};

/* ─── Event: Capture ───────────────────────────────────── */
document.getElementById("capture").onclick = async () => {
  renderAnswerValue("...");
  if (answerDetail) answerDetail.style.display = "none";
  answerHint.textContent = "AI đang suy luận...";
  showError("");

  const { answerMode = "accurate", geminiApiKey = "" } = await chrome.storage.local.get({
    answerMode: "accurate",
    geminiApiKey: ""
  });

  if (!geminiApiKey || !geminiApiKey.trim()) {
    renderAnswerValue("—");
    answerHint.textContent = "Thiếu API Key";
    showError("Vui lòng dán và Lưu Gemini API Key trước khi giải bài.");
    return;
  }

  const result = await chrome.runtime.sendMessage({
    type: "CAPTURE_AND_ANSWER",
    mode: answerMode === "fast" ? "fast" : "accurate"
  });

  if (result?.ok) {
    renderAnswerValue(result.answer);
    if (result.text && answerDetail) {
      answerDetail.textContent = result.text;
      answerDetail.style.display = "block";
    } else if (answerDetail) {
      answerDetail.style.display = "none";
    }
    answerHint.textContent = "Đã giải xong (" + (answerMode === "accurate" ? "3.8 Flash · 100%" : "Flash Lite") + ")";
  } else {
    renderAnswerValue("—");
    if (answerDetail) answerDetail.style.display = "none";
    answerHint.textContent = "Lỗi";
    showError(result?.error || "Không thể lấy đáp án");
  }
};

/* ─── Init ─────────────────────────────────────────────── */
async function init() {
  const data = await chrome.storage.local.get({
    enabled:        true,
    autoWayground:  false,
    answerMode:     "accurate",
    quizPeekTheme:  "light",
    geminiApiKey:   ""
  });

  // Apply saved theme
  applyTheme(data.quizPeekTheme || "light");
  renderAnswerMode(data.answerMode === "fast" ? "fast" : "accurate");

  enabled.setAttribute("aria-checked", String(Boolean(data.enabled)));
  autoWayground.setAttribute("aria-checked", String(Boolean(data.autoWayground)));
  renderStatus();

  // Load API key
  if (data.geminiApiKey) {
    apiKeyInput.value = data.geminiApiKey;
    verifyApiKey(data.geminiApiKey);
  } else {
    renderApiKeyStatus("none");
  }
}

init();