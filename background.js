const DEFAULT_API_KEY = "";

const GEMINI_MODELS = {
  accurate: "gemini-3.8-flash",
  fast: "gemini-3.5-flash-lite"
};

const pendingTabs = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get({
    enabled: true,
    autoWayground: false,
    answerMode: "accurate",
    geminiApiKey: ""
  });

  await chrome.storage.local.set({
    enabled: typeof data.enabled === "boolean" ? data.enabled : true,
    autoWayground: typeof data.autoWayground === "boolean" ? data.autoWayground : false,
    answerMode: "accurate",
    geminiApiKey: data.geminiApiKey || ""
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-extension") {
    const data = await chrome.storage.local.get({ enabled: true });
    const enabled = !data.enabled;
    await chrome.storage.local.set({ enabled });
    if (!enabled) {
      await updateAutoWatcher(false);
    }
    return;
  }

  if (command === "toggle-auto-wayground") {
    const state = await chrome.storage.local.get({
      enabled: true,
      autoWayground: false
    });
    if (!state.enabled) return;
    const autoWayground = !state.autoWayground;
    await chrome.storage.local.set({ autoWayground });
    await updateAutoWatcher(autoWayground);
    return;
  }

  if (command === "capture-answer") {
    await captureAndAnswer(true);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TEST_API_KEY") {
    testApiKey(message.apiKey)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "CAPTURE_AND_ANSWER") {
    captureAndAnswer(true, message.mode)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "SET_AUTO_WAYGROUND") {
    updateAutoWatcher(message.enabled);
    return;
  }

  if (message.type === "WAYGROUND_QUESTION") {
    const tabId = sender.tab?.id;
    if (!tabId || !message.signature) return;
    runAuto(tabId, message.signature, message.questionData);
  }
});

async function testApiKey(apiKey) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) {
    return { ok: false, error: "API Key không được để trống" };
  }

  const modelsToTest = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"];
  let lastMsg = "Key không hợp lệ hoặc đã hết hạn";

  for (const model of modelsToTest) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        return { ok: true, model };
      }
      lastMsg = data?.error?.message || `Lỗi (${response.status})`;
    } catch (e) {
      lastMsg = e.message || "Lỗi mạng";
    }
  }

  return { ok: false, error: lastMsg };
}

async function captureOptimized(windowId) {
  // Capture directly via Chrome API with 95% quality (clean, sharp, instant)
  const original = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: 95
  });
  return original;
}

async function getPageContext(tabId) {
  try {
    await ensureContent(tabId);
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "GET_PAGE_CONTEXT"
    });
    return result?.context || null;
  } catch {
    return null;
  }
}

function parseAnswerText(raw) {
  if (!raw) return { answer: "?", text: "", reasoning: "", display: "?" };
  const cleaned = raw.replace(/[\*\_`#]/g, "").trim();

  // 1. Multi-question check: "1: B | 2: C | 3: A" or lines like "1. A\n2. B"
  const multiMatches = [...cleaned.matchAll(/(?:Câu\s*)?(\d+)[\:\.\-\)]\s*([A-Za-z](?:[,\s]+[A-Za-z])*)/gi)];
  if (multiMatches.length >= 2) {
    const list = multiMatches.map(m => `${m[1]}: ${m[2].toUpperCase().trim()}`).join("  |  ");
    return {
      answer: list,
      text: "",
      reasoning: "",
      display: list,
      isMultiQuestion: true
    };
  }

  // 2. Extract [ĐÁP ÁN] letter accurately (avoiding matching "Chọn", "Phương án", etc.)
  let answerLetter = "";
  const ansRegex = /(?:\[?(?:ĐÁP ÁN|DAP AN|ANSWER|FINAL ANSWER|CHỌN|KẾT QUẢ)\]?)[^:\n\r]*[:\-\s]+(?:phương án|câu|lựa chọn|đáp án đúng là|đáp án)?\s*([A-H](?:\s*,\s*[A-H])*)\b/i;
  const ansMatch = cleaned.match(ansRegex);
  if (ansMatch && ansMatch[1]) {
    answerLetter = ansMatch[1].trim().toUpperCase().replace(/\s+/g, ", ");
  }

  // 3. Extract [NỘI DUNG]
  let answerContent = "";
  const contentMatch = cleaned.match(/\[?(?:NỘI DUNG|NOI DUNG|CONTENT|OPTION TEXT)\]?\s*[:\-\s]*(.+?)(?=\n\[|$)/i);
  if (contentMatch && contentMatch[1]) {
    answerContent = contentMatch[1].trim();
  }

  // 4. Extract [SUY LUẬN]
  let reasoning = "";
  const reasonMatch = cleaned.match(/\[?(?:SUY LUẬN|PHÂN TÍCH|GIẢI THÍCH|REASONING)\]?\s*[:\-\s]*(.+?)(?=\n\[|$)/is);
  if (reasonMatch && reasonMatch[1]) {
    reasoning = reasonMatch[1].trim().replace(/\s+/g, " ");
  }

  // 5. Fallback letter extraction
  if (!answerLetter) {
    const lineLetterMatch = cleaned.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:[Đđ]áp án|[Cc]họn)?\s*([A-D])\b/);
    if (lineLetterMatch) {
      answerLetter = lineLetterMatch[1].toUpperCase();
    } else {
      const loneMatch = cleaned.match(/\b([A-D])\b/);
      if (loneMatch) {
        answerLetter = loneMatch[1].toUpperCase();
      }
    }
  }

  if (!answerLetter) answerLetter = "?";

  // Build clean display
  let display = answerLetter;
  if (answerContent && answerLetter !== "?") {
    const shortContent = answerContent.length > 55 ? answerContent.slice(0, 52) + "..." : answerContent;
    display = `${answerLetter} (${shortContent})`;
  }

  return {
    answer: answerLetter,
    text: answerContent,
    reasoning,
    display
  };
}

async function askAI({ image, pageContext = null, mode = "accurate" }) {
  const stored = await chrome.storage.local.get({ geminiApiKey: "" });
  const apiKey = (stored.geminiApiKey || "").trim();

  if (!apiKey) {
    throw new Error("Chưa nhập Gemini API Key. Hãy mở icon tiện ích và dán key của bạn vào nhé!");
  }

  const isAccurate = mode === "accurate";
  const primaryModel = isAccurate ? GEMINI_MODELS.accurate : GEMINI_MODELS.fast;
  const base64Data = (image || "").replace(/^data:image\/[a-z]+;base64,/, "");

  let promptText = "";
  if (pageContext?.options && pageContext.options.length >= 2) {
    const optionsText = pageContext.options
      .map(o => `[${o.letter}] ${o.text}`)
      .join("\n");

    promptText = `Dưới đây là câu hỏi và các phương án được trích xuất trực tiếp từ bài thi (kèm ảnh chụp màn hình để đối chiếu hình vẽ, đồ thị, công thức):

CÂU HỎI:
${pageContext.question || "Xem trên ảnh màn hình"}

CÁC PHƯƠNG ÁN LỰA CHỌN:
${optionsText}
${pageContext.isMulti ? "\n(CHÚ Ý: Câu hỏi này là dạng chọn NHIỀU đáp án. Hãy chọn tất cả các phương án đúng, ví dụ: A, C)" : "\n(CHÚ Ý: Chọn DUY NHẤT 1 phương án đúng nhất)"}

QUY TRÌNH SUY LUẬN BẮT BUỘC ĐỂ ĐẠT ĐỘ CHÍNH XÁC 100%:
1. ĐỌC KỸ ĐỀ: Kiểm tra xem đề bài có chứa từ phủ định hoặc bẫy không ('KHÔNG', 'SAI', 'NGOẠI TRỪ', 'CHƯA ĐÚNG', 'NOT', 'EXCEPT', 'FALSE'). Nếu câu hỏi yêu cầu tìm phương án SAI/KHÔNG ĐÚNG, bạn BẮT BUỘC phải chọn phương án sai!
2. GIẢI & LOẠI TRỪ: Phân tích, tính toán hoặc giải thích ngắn gọn từng phương án. Loại bỏ các phương án gây nhiễu.
3. ĐỐI CHIẾU ẢNH: Nếu câu hỏi có hình vẽ, đồ thị, bảng biểu, sơ đồ hoặc công thức, hãy quan sát kỹ ảnh đính kèm để tính toán chuẩn xác.

ĐỊNH DẠNG TRẢ LỜI BẮT BUỘC:
[SUY LUẬN]: <1-2 câu giải thích cốt lõi hoặc phép tính ngắn gọn>
[ĐÁP ÁN]: <Chữ cái in hoa của phương án được chọn, ví dụ: A hoặc B... Nếu nhiều đáp án: A, C>
[NỘI DUNG]: <Trích nguyên văn nội dung của phương án đúng>`;
  } else if (pageContext?.selectedText) {
    promptText = `Văn bản được người dùng bôi đen trên trang:
"${pageContext.selectedText}"
(Kèm ảnh chụp màn hình để đối chiếu toàn cảnh).

QUY TRÌNH SUY LUẬN BẮT BUỘC:
1. Kiểm tra kỹ từ phủ định (KHÔNG, SAI, NGOẠI TRỪ...).
2. Phân tích, tính toán và loại trừ phương án sai.

ĐỊNH DẠNG TRẢ LỜI BẮT BUỘC:
[SUY LUẬN]: <1-2 câu giải thích hoặc phép tính>
[ĐÁP ÁN]: <Chữ cái in hoa của đáp án đúng, ví dụ: A>
[NỘI DUNG]: <Trích nội dung của phương án đúng>`;
  } else {
    promptText = `Hãy quan sát ảnh chụp màn hình chứa câu hỏi trắc nghiệm và các phương án (A, B, C, D...):

QUY TRÌNH SUY LUẬN BẮT BUỘC:
1. ĐỌC KỸ ĐỀ: Kiểm tra xem đề bài có chứa từ phủ định hoặc bẫy không ('KHÔNG', 'SAI', 'NGOẠI TRỪ', 'CHƯA ĐÚNG', 'NOT', 'EXCEPT'). Nếu hỏi câu SAI, BẮT BUỘC chọn phương án sai.
2. PHÂN TÍCH: Tính toán cẩn thận từng bước, đọc kỹ từng phương án để loại bỏ phương án sai.
3. NẾU CÓ NHIỀU CÂU HỎI TRÊN MÀN HÌNH (Câu 1, Câu 2...): Liệt kê đáp án theo mẫu: 1: A | 2: C | 3: B...

ĐỊNH DẠNG TRẢ LỜI BẮT BUỘC:
Nếu chỉ có 1 câu hỏi:
[SUY LUẬN]: <1-2 câu giải thích hoặc phép tính ngắn gọn>
[ĐÁP ÁN]: <Chữ cái in hoa của đáp án đúng, ví dụ: B>
[NỘI DUNG]: <Trích ngắn gọn nội dung của phương án được chọn>

Nếu có nhiều câu hỏi:
[DANH SÁCH]: 1: B | 2: C | 3: A`;
  }

  // Build parts according to official Google Gemini REST API specification:
  // Image part uses camelCase `inlineData` with `mimeType`!
  const parts = [];
  if (base64Data) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Data
      }
    });
  }
  parts.push({ text: promptText });

  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text: "Bạn là chuyên gia giải đề thi trắc nghiệm hàng đầu với mục tiêu đạt độ chính xác tuyệt đối 100%. Luôn đọc kỹ yêu cầu đề bài, đặc biệt chú ý các từ phủ định (KHÔNG, SAI, NGOẠI TRỪ, CHƯA ĐÚNG...). Phân tích từng phương án và loại trừ phương án sai trước khi chốt đáp án."
        }
      ]
    },
    contents: [
      {
        parts
      }
    ],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 2048
    }
  };

  const modelsToTry = [primaryModel];
  if (isAccurate) {
    if (!modelsToTry.includes("gemini-3.8-flash")) modelsToTry.push("gemini-3.8-flash");
    if (!modelsToTry.includes("gemini-2.5-flash")) modelsToTry.push("gemini-2.5-flash");
    if (!modelsToTry.includes("gemini-3.5-flash-lite")) modelsToTry.push("gemini-3.5-flash-lite");
  } else {
    if (!modelsToTry.includes("gemini-3.5-flash-lite")) modelsToTry.push("gemini-3.5-flash-lite");
    if (!modelsToTry.includes("gemini-3.8-flash")) modelsToTry.push("gemini-3.8-flash");
  }
  if (!modelsToTry.includes("gemini-flash-latest")) {
    modelsToTry.push("gemini-flash-latest");
  }

  let lastError = "Không thể kết nối AI";
  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(35000)
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        lastError = data?.error?.message || `Lỗi model ${model} (${response.status})`;
        console.warn(`Model ${model} failed:`, lastError);
        continue;
      }

      let candidateText = "";
      if (data?.candidates?.[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
          if (part.text) {
            candidateText += part.text + " ";
          }
        }
      }
      candidateText = candidateText.trim();

      if (!candidateText) {
        lastError = "AI phản hồi trống";
        continue;
      }

      const parsed = parseAnswerText(candidateText);
      return {
        ok: true,
        answer: parsed.answer,
        text: parsed.text,
        reasoning: parsed.reasoning,
        display: parsed.display,
        raw: candidateText
      };
    } catch (err) {
      lastError = err.message || "Lỗi kết nối";
    }
  }

  throw new Error(lastError);
}

async function runAuto(tabId, signature, questionData = null) {
  const state = await chrome.storage.local.get({
    enabled: true,
    autoWayground: false,
    answerMode: "accurate"
  });

  if (!state.enabled || !state.autoWayground) return;
  if (pendingTabs.has(tabId)) return;

  const { geminiApiKey } = await chrome.storage.local.get({ geminiApiKey: "" });
  if (!geminiApiKey || !geminiApiKey.trim()) return;

  pendingTabs.add(tabId);

  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const current = await getSignature(tabId);
    if (current !== signature) return;

    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return;

    let pageContext = null;
    if (questionData && questionData.options && questionData.options.length >= 2) {
      pageContext = questionData;
    } else {
      pageContext = await getPageContext(tabId);
    }

    const image = await captureOptimized(tab.windowId);
    const data = await askAI({
      image,
      pageContext,
      mode: state.answerMode
    });

    if (!data.ok || data.answer === "?") return;

    const latest = await getSignature(tabId);
    if (latest !== signature) return;

    await chrome.tabs.sendMessage(tabId, {
      type: "AUTO_SELECT",
      answer: data.answer,
      optionText: data.text,
      display: data.display,
      signature
    });
  } catch (error) {
    console.error("Auto error:", error);
  } finally {
    pendingTabs.delete(tabId);
  }
}

async function captureAndAnswer(showToast, requestedMode = null) {
  const state = await chrome.storage.local.get({
    enabled: true,
    answerMode: "accurate"
  });

  const answerMode =
    requestedMode === "accurate"
      ? "accurate"
      : requestedMode === "fast"
      ? "fast"
      : state.answerMode === "fast"
      ? "fast"
      : "accurate";

  if (!state.enabled) {
    return { ok: false, error: "Extension đang tắt" };
  }

  const { geminiApiKey } = await chrome.storage.local.get({ geminiApiKey: "" });
  if (!geminiApiKey || !geminiApiKey.trim()) {
    const errorMsg = "Chưa nhập API Key. Hãy bấm vào icon tiện ích và lưu key của bạn!";
    if (showToast) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await show(tab.id, errorMsg);
    }
    return { ok: false, error: errorMsg };
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !tab.windowId || !/^https?:/.test(tab.url || "")) {
    return { ok: false, error: "Trang này không thể chụp" };
  }

  if (pendingTabs.has(tab.id)) {
    return { ok: false, error: "Đang chờ AI suy luận..." };
  }

  pendingTabs.add(tab.id);

  try {
    if (showToast) {
      await show(tab.id, "Đang suy luận (100% chính xác)...", true);
    }

    const [pageContext, image] = await Promise.all([
      getPageContext(tab.id),
      captureOptimized(tab.windowId)
    ]);

    const data = await askAI({
      image,
      pageContext,
      mode: answerMode
    });

    if (!data.ok) {
      throw new Error(data.error || "Không thể phân tích ảnh");
    }

    if (showToast) {
      await show(tab.id, data.display || data.answer, false, data.reasoning);
    }

    return data;
  } catch (error) {
    const message =
      error.name === "TimeoutError"
        ? "AI phản hồi quá lâu. Vui lòng thử lại."
        : error.message || "Không thể lấy đáp án";

    if (showToast) {
      await show(tab.id, `Lỗi: ${message}`);
    }

    return { ok: false, error: message };
  } finally {
    pendingTabs.delete(tab.id);
  }
}

async function getSignature(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "GET_WAYGROUND_SIGNATURE"
    });
    return result?.signature || "";
  } catch {
    return "";
  }
}

async function show(tabId, text, loading = false, reasoning = "") {
  try {
    await ensureContent(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "AI_ANSWER",
      text,
      loading,
      reasoning
    });
  } catch {}
}

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function updateAutoWatcher(enabled) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    return;
  }

  try {
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      type: enabled ? "START_WAYGROUND_AUTO" : "STOP_WAYGROUND_AUTO"
    });
  } catch (error) {
    console.error("Watcher error:", error);
  }
}