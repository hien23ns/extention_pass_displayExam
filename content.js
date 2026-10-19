(() => {
  if (window.__quizPeekLoaded) return;
  window.__quizPeekLoaded = true;

  let observer = null;
  let lastSignature = "";
  let timer = null;

  function clean(text) {
    return text ? text.trim().replace(/\s+/g, " ") : "";
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function extractElementText(el) {
    if (!el) return "";
    let mathInfo = "";
    const tex = el.querySelector('annotation[encoding="application/x-tex"]');
    if (tex && tex.textContent) {
      mathInfo += ` [Công thức: ${clean(tex.textContent)}] `;
    }
    const imgs = el.querySelectorAll("img");
    for (const img of imgs) {
      if (img.alt && !img.alt.includes("avatar")) {
        mathInfo += ` [Hình: ${clean(img.alt)}] `;
      }
    }
    return clean(el.innerText) + mathInfo;
  }

  function getOptions() {
    // 1. Wayground / Quizizz
    let options = [
      ...document.querySelectorAll('button[role="option"]'),
      ...document.querySelectorAll('button[data-cy^="option-"]'),
      ...document.querySelectorAll('[role="option"]:not(span):not(p):not(img)')
    ];

    options = options.filter(el => {
      if (el.offsetParent === null && el.getBoundingClientRect().height === 0) return false;
      if (el.parentElement && el.parentElement.closest('button[role="option"], [role="option"]')) return false;
      return true;
    });

    options = [...new Set(options)];
    if (options.length >= 2) return options;

    return [];
  }

  function getQuestionText() {
    const selectors = [
      '[data-cy="question-text"]',
      '[data-testid="question-text"]',
      '#questionText',
      '.question-text',
      '[class*="question-text"]',
      '[class*="questionText"]',
      '[class*="QuestionText"]',
      '.qtext',
      '.quiz-question-text',
      'h2[class*="question"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        const text = extractElementText(el);
        if (text && text.length > 3) return text;
      }
    }

    return "";
  }

  function detectIsMultiSelect(questionText = "") {
    const qLower = (questionText || "").toLowerCase();
    const multiClues = [
      "chọn tất cả", "các đáp án", "những đáp án", "chọn nhiều",
      "select all", "which of the following are", "multi-select",
      "check all", "hộp kiểm"
    ];
    if (multiClues.some(clue => qLower.includes(clue))) return true;

    const checkboxes = document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], [data-cy*="multi"]'
    );
    if (checkboxes.length >= 2) return true;

    return false;
  }

  function getQuestionData() {
    const options = getOptions();
    const question = getQuestionText();

    if (options.length < 2) {
      return { hasData: false, question: "", options: [], signature: "", isMulti: false };
    }

    const parsedOptions = options.map((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const id = opt.getAttribute("data-cy") || opt.id || `opt-${i}`;

      const textEl = opt.querySelector("#optionText") ||
                     opt.querySelector('[data-cy="option-text"]') ||
                     opt.querySelector('[class*="optionText"]') ||
                     opt.querySelector('[class*="option-text"]') ||
                     opt;

      const text = extractElementText(textEl);

      return {
        letter,
        id,
        text,
        index: i,
        element: opt
      };
    });

    const isMulti = detectIsMultiSelect(question);
    const signature = `${question}||${parsedOptions.map(o => `${o.id}:${o.text}`).join("|")}`;

    return {
      hasData: true,
      question,
      options: parsedOptions,
      isMulti,
      signature
    };
  }

  // Multi-platform viewport-centered detection (Azota, Google Forms, Canvas, Moodle, Vietjack, Olm...)
  function extractFromContainer(container) {
    if (!container) return null;

    const titleSelectors = [
      '.content-question', '.question-title', '.qtext', '[class*="title"]',
      'h1, h2, h3, h4, h5', 'legend', '[role="heading"]',
      '.freebirdFormviewerComponentsQuestionBaseTitle',
      '[data-cy="question-text"]'
    ];
    let questionText = "";
    for (const sel of titleSelectors) {
      const el = container.querySelector(sel);
      if (el && isVisible(el)) {
        questionText = extractElementText(el);
        if (questionText.length > 3) break;
      }
    }

    const optionSelectors = [
      '.answer-item', '[class*="answer-item"]',
      '[role="radio"]', '[role="checkbox"]', '.docssharedWizToggleLabeledContainer',
      'label', '.option', '.answer'
    ];

    let optionEls = [];
    for (const sel of optionSelectors) {
      const found = container.querySelectorAll(sel);
      if (found.length >= 2 && found.length <= 10) {
        optionEls = [...found].filter(el => {
          if (!isVisible(el)) return false;
          if (el.parentElement && el.parentElement.closest(sel)) return false;
          return true;
        });
        if (optionEls.length >= 2) break;
      }
    }

    if (optionEls.length < 2) return null;

    const options = optionEls.map((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      let text = extractElementText(opt);
      text = text.replace(/^[A-H][\.\:\)\-\s]+/i, "").trim();
      return { letter, text };
    });

    const isMulti = detectIsMultiSelect(questionText);

    return {
      question: questionText,
      options,
      isMulti,
      signature: `${questionText}||${options.map(o => o.text).join("|")}`
    };
  }

  function getPageContext() {
    // 1. If user highlighted text, use it as primary focus
    const selection = window.getSelection()?.toString()?.trim();
    if (selection && selection.length >= 8) {
      return {
        type: "selection",
        selectedText: selection
      };
    }

    // 2. Wayground / Quizizz
    const wayground = getQuestionData();
    if (wayground.hasData) {
      return {
        type: "structured",
        question: wayground.question,
        options: wayground.options.map(o => ({ letter: o.letter, text: o.text })),
        isMulti: wayground.isMulti,
        signature: wayground.signature
      };
    }

    // 3. Multi-platform question container detection
    const containerSelectors = [
      '.item-question', '.question-item', '[class*="item-question"]', '[class*="question-item"]',
      '[role="listitem"]', '.freebirdFormviewerViewNumberedItemContainer', '.Qr7Oae',
      '.question_holder', '.que', '.display_question',
      '[data-cy="question-container"]', '.quiz-question', '.question', 'fieldset'
    ];

    let allContainers = [];
    for (const sel of containerSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        allContainers = [...found].filter(isVisible);
        if (allContainers.length > 0) break;
      }
    }

    if (allContainers.length > 0) {
      const viewportCenter = window.innerHeight / 2;
      let bestContainer = null;
      let minDistance = Infinity;

      for (const c of allContainers) {
        const rect = c.getBoundingClientRect();
        if (rect.bottom > 40 && rect.top < window.innerHeight - 40) {
          const containerCenter = rect.top + rect.height / 2;
          const dist = Math.abs(containerCenter - viewportCenter);
          if (dist < minDistance) {
            minDistance = dist;
            bestContainer = c;
          }
        }
      }

      if (bestContainer) {
        const extracted = extractFromContainer(bestContainer);
        if (extracted && extracted.options.length >= 2) {
          return {
            type: "structured",
            question: extracted.question,
            options: extracted.options,
            isMulti: extracted.isMulti,
            signature: extracted.signature
          };
        }
      }
    }

    return { type: "visual_only" };
  }

  function detectQuestion() {
    const qData = getQuestionData();
    if (!qData.hasData || qData.signature === lastSignature) return;

    lastSignature = qData.signature;

    chrome.runtime.sendMessage({
      type: "WAYGROUND_QUESTION",
      signature: qData.signature,
      questionData: {
        question: qData.question,
        options: qData.options.map(o => ({ letter: o.letter, text: o.text })),
        isMulti: qData.isMulti
      }
    });
  }

  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(detectQuestion, 350);
  }

  function startAuto() {
    if (observer) {
      scheduleCheck();
      return;
    }

    lastSignature = "";

    observer = new MutationObserver(() => {
      scheduleCheck();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    scheduleCheck();
  }

  function stopAuto() {
    observer?.disconnect();
    observer = null;

    clearTimeout(timer);
    timer = null;
    lastSignature = "";
  }

  function triggerClick(element) {
    if (!element) return;
    const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const evt of events) {
      try {
        element.dispatchEvent(new MouseEvent(evt, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      } catch {}
    }
    try {
      element.click?.();
    } catch {}
  }

  function selectAnswer(answer, optionText, signature) {
    if (signature) {
      const curData = getQuestionData();
      if (curData.hasData && curData.signature !== signature) {
        return;
      }
    }

    const options = getOptions();
    if (!options.length) return;

    let letters = [];
    if (typeof answer === "string") {
      letters = answer
        .toUpperCase()
        .split(/[,;&|\/]+/)
        .map(x => x.trim().match(/[A-Z]/)?.[0])
        .filter(Boolean);
    }

    const toClick = new Set();

    for (const letter of letters) {
      const index = letter.charCodeAt(0) - 65;
      if (index >= 0 && index < options.length) {
        toClick.add(options[index]);
      }
    }

    if (optionText && optionText.trim().length >= 2) {
      const cleanTarget = clean(optionText).toLowerCase();

      let matchedByText = null;
      for (const opt of options) {
        const optText = clean(opt.innerText).toLowerCase();
        if (optText && (optText.includes(cleanTarget) || cleanTarget.includes(optText))) {
          matchedByText = opt;
          break;
        }
      }

      if (matchedByText) {
        if (letters.length <= 1) {
          toClick.clear();
        }
        toClick.add(matchedByText);
      }
    }

    for (const opt of toClick) {
      try {
        opt.focus?.();
        triggerClick(opt);
      } catch {
        opt.click();
      }
    }
  }

  function showToast(text, loading = false, reasoning = "") {
    if (window.__quizPeekDismissListener) {
      document.removeEventListener("pointerdown", window.__quizPeekDismissListener, true);
      document.removeEventListener("keydown", window.__quizPeekDismissListener, true);
      window.__quizPeekDismissListener = null;
    }
    document.getElementById("__quizpeek_answer_toast")?.remove();

    const el = document.createElement("div");
    el.id = "__quizpeek_answer_toast";

    Object.assign(el.style, {
      position: "fixed",
      right: "14px",
      top: "12px",
      zIndex: "2147483647",
      maxWidth: "80vw",
      minWidth: "140px",
      padding: "8px 14px",
      borderRadius: "10px",
      background: "#ffffff",
      color: "#0f172a",
      border: "1.5px solid #22c55e",
      boxShadow: "0 8px 24px -4px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.08)",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      pointerEvents: "auto",
      cursor: "pointer",
      userSelect: "none",
      transition: "all 0.18s ease",
      display: "flex",
      flexDirection: "column",
      gap: "3px"
    });

    if (loading) {
      el.style.border = "1.5px solid #6366f1";
      el.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#6366f1; animation:quizPeekPulse 1s infinite alternate ease-in-out;"></span>
          <span style="font-weight:700; font-size:12px; color:#4338ca;">${text || "Đang suy luận (100% chuẩn)..."}</span>
        </div>
      `;
    } else {
      const letterMatch = text.match(/^([A-D](?:\s*,\s*[A-D])*)\s*(?:\((.*)\))?$/);
      if (letterMatch) {
        const letter = letterMatch[1];
        const content = letterMatch[2] || "";
        el.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="background:#22c55e; color:#ffffff; font-weight:900; font-size:15px; padding:2px 9px; border-radius:6px; letter-spacing:0.02em;">
              ${letter}
            </span>
            <span style="font-weight:700; font-size:12.5px; color:#0f172a; line-height:1.2;">
              ${content ? content : "Đáp án đúng"}
            </span>
          </div>
          ${reasoning ? `<div style="font-size:10.5px; color:#64748b; font-weight:500; margin-top:2px; border-top:1px dashed #e2e8f0; padding-top:3px; max-width:340px; white-space:normal;">${reasoning.slice(0, 120)}${reasoning.length > 120 ? "..." : ""}</div>` : ""}
        `;
      } else {
        el.innerHTML = `
          <div style="font-weight:800; font-size:13px; color:#0f172a; line-height:1.3; white-space:pre-wrap;">
            ${text}
          </div>
          ${reasoning ? `<div style="font-size:10.5px; color:#64748b; margin-top:3px;">${reasoning.slice(0, 100)}</div>` : ""}
        `;
      }
    }

    el.onmouseenter = () => { el.style.transform = "translateY(-1px) scale(1.01)"; el.style.boxShadow = "0 12px 28px -4px rgba(0,0,0,0.2)"; };
    el.onmouseleave = () => { el.style.transform = "none"; el.style.boxShadow = "0 8px 24px -4px rgba(0,0,0,0.15)"; };

    document.documentElement.appendChild(el);

    const dismissToast = () => {
      el.remove();
      if (window.__quizPeekDismissListener) {
        document.removeEventListener("pointerdown", window.__quizPeekDismissListener, true);
        document.removeEventListener("keydown", window.__quizPeekDismissListener, true);
        window.__quizPeekDismissListener = null;
      }
    };

    if (!loading) {
      window.__quizPeekDismissListener = (e) => {
        if (e.type === "keydown" && e.key !== "Escape") return;
        dismissToast();
      };
      setTimeout(() => {
        document.addEventListener("pointerdown", window.__quizPeekDismissListener, true);
        document.addEventListener("keydown", window.__quizPeekDismissListener, true);
      }, 100);

      setTimeout(dismissToast, 15000);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "START_WAYGROUND_AUTO") {
      startAuto();
      return;
    }

    if (message.type === "STOP_WAYGROUND_AUTO") {
      stopAuto();
      return;
    }

    if (message.type === "GET_WAYGROUND_SIGNATURE") {
      sendResponse({
        signature: getQuestionData().signature
      });
      return;
    }

    if (message.type === "GET_PAGE_CONTEXT") {
      sendResponse({
        context: getPageContext()
      });
      return;
    }

    if (message.type === "AUTO_SELECT") {
      selectAnswer(
        message.answer,
        message.optionText,
        message.signature
      );
      showToast(message.display || message.answer, false);
      return;
    }

    if (message.type === "AI_ANSWER") {
      showToast(message.text, message.loading, message.reasoning);
      return;
    }
  });

  if (!document.getElementById("__quizpeek_styles")) {
    const style = document.createElement("style");
    style.id = "__quizpeek_styles";
    style.textContent = `
      @keyframes quizPeekPulse {
        0% { transform: scale(0.85); opacity: 0.6; }
        100% { transform: scale(1.2); opacity: 1; }
      }
    `;
    document.head?.appendChild(style);
  }

  chrome.storage.local.get({
    enabled: true,
    autoWayground: false
  }).then(state => {
    if (state.enabled && state.autoWayground) {
      startAuto();
    }
  });
})();