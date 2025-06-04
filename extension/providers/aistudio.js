
class AIStudioProvider {
  constructor() {
    this.captureMethod = "debugger";
    this.debuggerUrlPattern = "*MakerSuiteService/GenerateContent*";
    this.includeThinkingInMessage = false;

    this.ENABLE_AISTUDIO_FUNCTION_CALLING = true;

    this.name = "AIStudioProvider";
    this.supportedDomains = ["aistudio.google.com"];

    this.inputSelector = 'textarea.textarea, textarea.gmat-body-medium, textarea[aria-label="Type something or pick one from prompt gallery"]';

    this.sendButtonSelector = 'button.run-button, button[aria-label="Run"], button.mat-mdc-tooltip-trigger.run-button';

    this.responseSelector = '.response-container, .response-text, .model-response, .model-response-container, ms-chat-turn, ms-prompt-chunk, ms-text-chunk, .very-large-text-container, .cmark-node';

    this.thinkingIndicatorSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, loading-indicator';

    this.responseSelectorForDOMFallback = '.response-container, .model-response-text';
    this.thinkingIndicatorSelectorForDOM = '.thinking-indicator, .spinner';

    this.lastSentMessage = '';

    this.pendingResponseCallbacks = new Map();

    this.ensureFunctionCallingEnabled();

    if (window.navigation) {
      window.navigation.addEventListener('navigate', (event) => {
        if (!event.canIntercept || event.hashChange || event.downloadRequest !== null) {
          return;
        }
        const currentUrl = new URL(window.location.href);
        const destinationUrl = new URL(event.destination.url);

        if (currentUrl.origin === destinationUrl.origin && destinationUrl.pathname.startsWith("/prompts/")) {
          console.log(`[${this.name}] Detected SPA navigation to: ${event.destination.url}. Re-checking function calling toggle.`);
          setTimeout(() => {
            this.ensureFunctionCallingEnabled();
          }, 1000);
        }
      });
    } else {
      console.warn(`[${this.name}] window.navigation API not available. Function calling toggle may not re-enable on SPA navigations.`);
    }
  }

  ensureFunctionCallingEnabled() {
    if (!this.ENABLE_AISTUDIO_FUNCTION_CALLING) {
      console.log(`[${this.name}] Function calling is disabled by configuration. Skipping.`);
      return;
    }

    const checkInterval = 500;
    const maxDuration = 7000;
    let elapsedTime = 0;
    const providerName = this.name;

    if (this.functionCallingPollTimer) {
      clearTimeout(this.functionCallingPollTimer);
      this.functionCallingPollTimer = null;
      console.log(`[${providerName}] Cleared previous function calling poll timer.`);
    }

    console.log(`[${providerName}] Ensuring function calling is enabled (polling up to ${maxDuration / 1000}s).`);

    const tryEnableFunctionCalling = () => {
      console.log(`[${providerName}] Polling for function calling toggle. Elapsed: ${elapsedTime}ms`);
      const functionCallingToggle = document.querySelector('button[aria-label="Function calling"]');

      if (functionCallingToggle) {
        const isChecked = functionCallingToggle.getAttribute('aria-checked') === 'true';
        if (!isChecked) {
          console.log(`[${providerName}] Function calling toggle found and is NOT checked. Attempting to enable...`);
          functionCallingToggle.click();
          setTimeout(() => {
            const stillChecked = functionCallingToggle.getAttribute('aria-checked') === 'true';
            if (stillChecked) {
              console.log(`[${providerName}] Function calling successfully enabled after click.`);
            } else {
              console.warn(`[${providerName}] Clicked function calling toggle, but it did NOT become checked. It might be disabled or unresponsive.`);
            }
          }, 200);
        } else {
          console.log(`[${providerName}] Function calling toggle found and is already enabled.`);
        }
        this.functionCallingPollTimer = null;
      } else {
        elapsedTime += checkInterval;
        if (elapsedTime < maxDuration) {
          console.log(`[${providerName}] Function calling toggle not found, will retry in ${checkInterval}ms.`);
          this.functionCallingPollTimer = setTimeout(tryEnableFunctionCalling, checkInterval);
        } else {
          console.warn(`[${providerName}] Function calling toggle button (selector: 'button[aria-label="Function calling"]') not found after ${maxDuration}ms. It might not be available on this page/view or selector is incorrect.`);
          this.functionCallingPollTimer = null;
        }
      }
    };

    this.functionCallingPollTimer = setTimeout(tryEnableFunctionCalling, 500);
  }

  async sendChatMessage(messageContent, requestId) {
    console.log(`[${this.name} REQ-${requestId}] sendChatMessage called with content type:`, typeof messageContent, Array.isArray(messageContent) ? `Array length: ${messageContent.length}` : '');
    const inputField = document.querySelector(this.inputSelector);

    if (!inputField) {
      console.error(`[${this.name} REQ-${requestId}] Missing input field. Input selector: ${this.inputSelector}`);
      return false;
    }

    // Deferred sendButton logging moved to after it's defined

    try {
      let textToInput = "";
      let blobToPaste = null;
      let blobMimeType = "image/png";

      if (typeof messageContent === 'string') {
        textToInput = messageContent;
        this.lastSentMessage = textToInput;
        console.log(`[${this.name}] Handling string content:`, textToInput.substring(0, 100) + "...");
      } else if (messageContent instanceof Blob) {
        blobToPaste = messageContent;
        blobMimeType = messageContent.type || blobMimeType;
        this.lastSentMessage = `Blob data (type: ${blobMimeType}, size: ${blobToPaste.size})`;
        console.log(`[${this.name}] Handling Blob content. Size: ${blobToPaste.size}, Type: ${blobMimeType}`);
      } else if (Array.isArray(messageContent)) {
        console.log(`[${this.name}] Handling array content.`);
        for (const part of messageContent) {
          if (part.type === "text" && typeof part.text === 'string') {
            textToInput += (textToInput ? "\n" : "") + part.text;
            console.log(`[${this.name}] Added text part:`, part.text.substring(0, 50) + "...");
          } else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === 'string') {
            if (!blobToPaste) {
              try {
                const response = await fetch(part.image_url.url);
                blobToPaste = await response.blob();
                blobMimeType = blobToPaste.type || blobMimeType;
                console.log(`[${this.name}] Fetched image_url as Blob. Size: ${blobToPaste.size}, Type: ${blobMimeType}`);
              } catch (e) {
                console.error(`[${this.name}] Error fetching image_url ${part.image_url.url}:`, e);
              }
            } else {
              console.warn(`[${this.name}] Multiple image_urls found, only the first will be pasted.`);
            }
          }
        }
        this.lastSentMessage = `Array content (Text: "${textToInput.substring(0, 50)}...", Image: ${blobToPaste ? 'Yes' : 'No'})`;
      } else {
        console.error(`[${this.name}] Unhandled message content type: ${typeof messageContent}. Cannot send.`);
        this.lastSentMessage = `Unhandled data type: ${typeof messageContent}`;
        return false;
      }

      if (textToInput) {
        inputField.value = textToInput;
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[${this.name}] Set input field value with accumulated text.`);
      } else {
      }

      if (blobToPaste) {
        const dataTransfer = new DataTransfer();
        const file = new File([blobToPaste], "pasted_image." + (blobMimeType.split('/')[1] || 'png'), { type: blobMimeType });
        dataTransfer.items.add(file);
        const pasteEvent = new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true
        });
        inputField.dispatchEvent(pasteEvent);
        console.log(`[${this.name}] Dispatched paste event with Blob data.`);
      }

      inputField.focus();
      await new Promise(resolve => setTimeout(resolve, 100));

      let attempts = 0;
      const maxAttempts = 60;
      const retryDelay = 5000;

      while (attempts < maxAttempts) {
        const sendButton = document.querySelector(this.sendButtonSelector);
        if (attempts === 0) {
          console.log(`[${this.name} REQ-${requestId}] Initial attempt to send. Input field class: ${inputField.className}. Send button details:`,
            sendButton ? {
              ariaLabel: sendButton.getAttribute('aria-label'),
              className: sendButton.className,
              selector: this.sendButtonSelector
            } : "NOT FOUND");
        }
        if (!sendButton) {
          console.warn(`[${this.name} REQ-${requestId}] Send button not found (attempt ${attempts + 1}). Will retry.`);
          attempts++;
          if (attempts >= maxAttempts) {
            console.error(`[${this.name} REQ-${requestId}] Send button not found after ${maxAttempts} attempts.`);
            return false;
          }
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

        const isDisabled = sendButton.disabled ||
          sendButton.getAttribute('aria-disabled') === 'true' ||
          sendButton.classList.contains('disabled');

        if (!isDisabled) {
          console.log(`[${this.name} REQ-${requestId}] Send button is enabled. Clicking send button (attempt ${attempts + 1}).`);
          sendButton.click();
          return true;
        }

        attempts++;
        if (attempts >= maxAttempts) {
          console.error(`[${this.name}] Send button remained disabled after ${maxAttempts} attempts. Failed to send message.`);
          return false;
        }

        console.log(`[${this.name}] Send button is disabled (attempt ${attempts}). Trying to enable and will retry in ${retryDelay}ms.`);
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
        inputField.dispatchEvent(new Event('blur', { bubbles: true }));
        inputField.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        inputField.blur();

        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
      console.error(`[${this.name}] Exited send button check loop unexpectedly.`);
      return false;
    } catch (error) {
      console.error(`[${this.name} REQ-${requestId}] Error sending message to AI Studio:`, error);
      return false;
    }
  }

  initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. CURRENT CAPTURE METHOD IS: ${this.captureMethod}`);
    if (this.captureMethod === "debugger") {
      this.pendingResponseCallbacks.set(requestId, responseCallback);
      console.log(`[${this.name}] Stored callback for debugger response, requestId: ${requestId}`);
    } else if (this.captureMethod === "dom") {
      console.log(`[${this.name}] Starting DOM monitoring for requestId: ${requestId}`);
      this.pendingResponseCallbacks.set(requestId, responseCallback);
      this._stopDOMMonitoring();
      this._startDOMMonitoring(requestId);
    } else {
      console.error(`[${this.name}] Unknown capture method: ${this.captureMethod}`);
      responseCallback(requestId, `[Error: Unknown capture method '${this.captureMethod}' in provider]`, true);
      this.pendingResponseCallbacks.delete(requestId);
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground) {
    console.log(`[${this.name}] handleDebuggerData called for requestId: ${requestId}. Raw data length: ${rawData ? rawData.length : 'null'}. isFinalFromBackground: ${isFinalFromBackground}`);
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) {
      console.warn(`[${this.name}] No pending callback found for debugger data with requestId: ${requestId}. Ignoring.`);
      return;
    }

    let parsedText = "";
    let contentHasInternalFinalMarker = false;

    if (rawData && rawData.trim() !== "") {
      const parseOutput = this.parseDebuggerResponse(rawData);
      parsedText = parseOutput.text;
      contentHasInternalFinalMarker = parseOutput.isFinalResponse;
      console.log(`[${this.name}] Debugger data parsed for requestId: ${requestId}. Parsed text (first 100 chars): '${(parsedText || "").substring(0, 100)}', Type: ${typeof parsedText}, ChunkHasFinalMarkerFromParser: ${contentHasInternalFinalMarker}`);
    } else {
      console.log(`[${this.name}] Received empty rawData from debugger for requestId: ${requestId}. isFinalFromBackground: ${isFinalFromBackground}`);
    }

    const isFinalForCallback = isFinalFromBackground || contentHasInternalFinalMarker;

    console.log(`[${this.name}] Calling callback for requestId ${requestId} with text (first 100): '${(parsedText || "").substring(0, 100)}', isFinalForCallback: ${isFinalForCallback} (isFinalFromBackground: ${isFinalFromBackground}, contentHasInternalFinalMarker: ${contentHasInternalFinalMarker})`);
    callback(requestId, parsedText, isFinalForCallback);

    if (isFinalForCallback) {
      console.log(`[${this.name}] Final event processed for requestId: ${requestId} (isFinalForCallback was true). Removing callback.`);
      this.pendingResponseCallbacks.delete(requestId);
    }
  }

  _captureResponseDOM(element = null) {
    console.log(`[${this.name}] _captureResponseDOM (DOM method) called with element:`, element);
    if (!element && this.captureMethod === "dom") {
      const elements = document.querySelectorAll(this.responseSelector);
      if (elements.length > 0) {
        element = elements[elements.length - 1];
        console.log(`[${this.name}] _captureResponseDOM: Found element via querySelector during polling.`);
      }
    }
    if (!element) {
      console.log(`[${this.name}] _captureResponseDOM: No element provided or found.`);
      return { found: false, text: '' };
    }
    if (this._isResponseStillGeneratingDOM()) {
      console.log(`[${this.name}] Response is still being generated (_isResponseStillGeneratingDOM check), waiting for completion`);
      return { found: false, text: '' };
    }
    console.log(`[${this.name}] Attempting to capture DOM response from AI Studio...`);
    let responseText = "";
    let foundResponse = false;
    try {
      console.log("AISTUDIO: Looking for response in various elements...");
      if (element.textContent) {
        console.log("AISTUDIO: Element has text content");
        responseText = element.textContent.trim();
        if (responseText &&
          !responseText.includes("Loading") &&
          !responseText.includes("Thinking") &&
          !responseText.includes("Expand to view model thoughts")) {
          console.log("AISTUDIO: Found response in element:", responseText.substring(0, 50) + (responseText.length > 50 ? "..." : ""));
          foundResponse = true;
        } else {
          console.log("AISTUDIO: Element text appears to be invalid:", responseText.substring(0, 50) + (responseText.length > 50 ? "..." : ""));
        }
      } else {
        console.log("AISTUDIO: Element has no text content");
      }
      console.log("AISTUDIO: Trying to find the most recent chat turn...");
      const chatTurns = document.querySelectorAll('ms-chat-turn');
      if (chatTurns && chatTurns.length > 0) {
        console.log(`AISTUDIO: Found ${chatTurns.length} chat turns`);
        const lastChatTurn = chatTurns[chatTurns.length - 1];
        const isModelTurn = lastChatTurn.querySelector('.model-prompt-container');
        if (isModelTurn) {
          console.log("AISTUDIO: Last chat turn is a model turn");
          const allTextChunks = document.querySelectorAll('ms-text-chunk');
          if (allTextChunks && allTextChunks.length > 0) {
            console.log(`AISTUDIO: Found ${allTextChunks.length} ms-text-chunk elements in the document`);
            const lastTextChunk = allTextChunks[allTextChunks.length - 1];
            console.log("AISTUDIO: Last ms-text-chunk found:", lastTextChunk);
            const responseSpan = lastTextChunk.querySelector('span.ng-star-inserted');
            if (responseSpan) {
              console.log("AISTUDIO: Found response span in last ms-text-chunk");
              const text = responseSpan.textContent.trim();
              if (text &&
                !text.includes("Loading") && !text.includes("Thinking") && !text.includes("Expand to view model thoughts")) {
                responseText = text;
                console.log("AISTUDIO: Found response in span:", responseText.substring(0, 50) + (responseText.length > 50 ? "..." : ""));
                foundResponse = true;
              }
            } else {
              console.log("AISTUDIO: No response span found, getting text directly from ms-text-chunk");
              const text = lastTextChunk.textContent.trim();
              if (text &&
                !text.includes("Loading") && !text.includes("Thinking") && !text.includes("Expand to view model thoughts")) {
                responseText = text;
                console.log("AISTUDIO: Found response in ms-text-chunk:", responseText.substring(0, 50) + (responseText.length > 50 ? "..." : ""));
                foundResponse = true;
              }
            }
          }
          if (!foundResponse) {
            const paragraphs = lastChatTurn.querySelectorAll('p');
            if (paragraphs && paragraphs.length > 0) {
              console.log(`AISTUDIO: Found ${paragraphs.length} paragraphs in last chat turn`);
              let combinedText = "";
              paragraphs.forEach((p) => {
                const isInThoughtChunk = p.closest('ms-thought-chunk');
                if (!isInThoughtChunk) {
                  const text = p.textContent.trim();
                  if (text &&
                    !text.includes("Loading") && !text.includes("Thinking") && !text.includes("Expand to view model thoughts")) {
                    combinedText += text + "\n";
                  }
                }
              });
              if (combinedText.trim()) {
                responseText = combinedText.trim();
                console.log("AISTUDIO: Found response in paragraphs:", responseText.substring(0, 50) + (responseText.length > 50 ? "..." : ""));
                foundResponse = true;
              }
            }
          }
        }
      }
      if (!foundResponse) {
        console.log("AISTUDIO: Trying to find ms-chat-turn elements (fallback)...");
        const chatTurnsFallback = document.querySelectorAll('ms-chat-turn');
        if (chatTurnsFallback && chatTurnsFallback.length > 0) {
          const lastChatTurnFallback = chatTurnsFallback[chatTurnsFallback.length - 1];
          const paragraphsFallback = lastChatTurnFallback.querySelectorAll('p');
          if (paragraphsFallback && paragraphsFallback.length > 0) {
            let combinedTextFallback = "";
            paragraphsFallback.forEach((p) => {
              const text = p.textContent.trim();
              if (text &&
                !text.includes("Loading") && !text.includes("Thinking") && !text.includes("Expand to view model thoughts")) {
                combinedTextFallback += text + "\n";
              }
            });
            if (combinedTextFallback.trim()) {
              responseText = combinedTextFallback.trim();
              foundResponse = true;
            }
          }
          if (!foundResponse) {
            const textFallback = lastChatTurnFallback.textContent.trim();
            if (textFallback &&
              !textFallback.includes("Loading") && !textFallback.includes("Thinking") && !textFallback.includes("Expand to view model thoughts")) {
              responseText = textFallback;
              foundResponse = true;
            }
          }
        }
      }
      if (!foundResponse) {
        console.log("AISTUDIO: Trying to find .very-large-text-container elements...");
        const textContainers = document.querySelectorAll('.very-large-text-container');
        if (textContainers && textContainers.length > 0) {
          for (let i = textContainers.length - 1; i >= 0; i--) {
            const textContainer = textContainers[i];
            const text = textContainer.textContent.trim();
            if (text &&
              !text.includes("Loading") && !text.includes("Thinking") && !text.includes("Expand to view model thoughts")) {
              responseText = text;
              foundResponse = true;
              break;
            }
          }
        }
      }
      if (!foundResponse) {
        console.log("AISTUDIO: Trying to find paragraphs in the document (last resort)...");
        const paragraphsDoc = document.querySelectorAll('p');
        if (paragraphsDoc && paragraphsDoc.length > 0) {
          let combinedTextDoc = "";
          for (let i = paragraphsDoc.length - 1; i >= 0; i--) {
            const paragraph = paragraphsDoc[i];
            const isUserChunk = paragraph.closest('.user-chunk');
            if (isUserChunk) continue;
            const text = paragraph.textContent.trim();
            if (text &&
              !text.includes("Loading") && !text.includes("Thinking") && !text.includes("Expand to view model thoughts")) {
              combinedTextDoc = text + "\n" + combinedTextDoc;
              if (text.startsWith("Hello") || text.includes("I'm doing") || text.includes("How can I assist")) break;
            }
          }
          if (combinedTextDoc.trim()) {
            responseText = combinedTextDoc.trim();
            foundResponse = true;
          }
        }
      }
      if (!foundResponse) {
        console.log("AISTUDIO: Response not found yet via DOM.");
      }
    } catch (error) {
      console.error("AISTUDIO: Error capturing response from AI Studio (DOM):", error);
    }
    if (foundResponse && responseText) {
      responseText = responseText.trim()
        .replace(/^(Loading|Thinking).*/gim, '')
        .replace(/Expand to view model thoughts.*/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return {
      found: foundResponse && !!responseText.trim(),
      text: responseText
    };
  }

  parseDebuggerResponse(jsonString) {
    console.log(`[${this.name}] Parsing debugger response (AI Studio specific)... Input jsonString (first 200):`, jsonString ? jsonString.substring(0, 200) : "null", "Type:", typeof jsonString);

    if (!jsonString || jsonString.trim() === "") {
      console.warn(`[${this.name}] parseDebuggerResponse called with empty or null jsonString.`);
      return { text: "", isFinalResponse: false };
    }

    let thinkingAndProcessText = "";
    let actualResponseText = "";
    let overallMarkerFound = false;

    function findEndOfUnitMarker(data) {
      if (Array.isArray(data)) {
        if (data.length >= 2 && data[data.length - 1] === 1 && data[data.length - 2] === "model") {
          return true;
        }
        for (const item of data) {
          if (findEndOfUnitMarker(item)) {
            return true;
          }
        }
      }
      return false;
    }

    function extractTextSegments(data, segments = []) {
      if (Array.isArray(data)) {
        if (data.length > 1 && data[0] === null && typeof data[1] === 'string') {
          segments.push(data[1]);
        } else {
          for (const item of data) {
            extractTextSegments(item, segments);
          }
        }
      }
      return segments;
    }

    try {
      const parsedJson = JSON.parse(jsonString);
      if (Array.isArray(parsedJson)) {
        for (let i = 0; i < parsedJson.length; i++) {
          const chunk = parsedJson[i];
          const textSegmentsInChunk = extractTextSegments(chunk);
          if (textSegmentsInChunk.length > 0) {
            actualResponseText += textSegmentsInChunk.join("");
          }
          if (findEndOfUnitMarker(chunk)) {
            overallMarkerFound = true;
          }
          if (this.includeThinkingInMessage) {
            if (Array.isArray(chunk) && chunk[0] && Array.isArray(chunk[0][0]) && chunk[0][0][2]) {
              const potentialThinkingBlock = chunk[0][0][2];
              const thinkingSegments = extractTextSegments(potentialThinkingBlock);
              const thinkingBlockText = thinkingSegments.join("").trim();
              if (thinkingBlockText && !actualResponseText.includes(thinkingBlockText)) {
                thinkingAndProcessText += thinkingBlockText + "\n";
              }
            }
          }
        }
      } else {
        if (typeof parsedJson === 'string') {
          actualResponseText = parsedJson;
          overallMarkerFound = true;
        } else {
          console.warn(`[${this.name}] Parsed JSON is not an array as expected. Type: ${typeof parsedJson}. Content (first 100): ${JSON.stringify(parsedJson).substring(0, 100)}`);
          const genericText = extractTextSegments(parsedJson).join("");
          if (genericText) {
            actualResponseText = genericText;
            overallMarkerFound = true;
          } else {
            actualResponseText = "[Error: Unexpected JSON structure from AI Studio]";
            overallMarkerFound = true;
          }
        }
      }

      actualResponseText = actualResponseText.replace(/\\n/g, "\n").replace(/\n\s*\n/g, '\n').trim();
      thinkingAndProcessText = thinkingAndProcessText.replace(/\\n/g, "\n").replace(/\n\s*\n/g, '\n').trim();

    } catch (e) {
      console.error(`[${this.name}] Error parsing AI Studio debugger response JSON:`, e, "Original string (first 200 chars):", jsonString.substring(0, 200));
      const formattedFallback = this.formatOutput("", jsonString);
      return { text: formattedFallback, isFinalResponse: true };
    }

    const formattedOutput = this.formatOutput(thinkingAndProcessText, actualResponseText);
    if (formattedOutput.trim() === "" && overallMarkerFound) {
      return { text: "", isFinalResponse: true };
    }
    return { text: formattedOutput, isFinalResponse: overallMarkerFound };
  }

  formatOutput(thinkingText, answerText) {
    if (this.includeThinkingInMessage && thinkingText && thinkingText.trim() !== "") {
      try {
        const result = {
          thinking: thinkingText.trim(),
          answer: (answerText || "").trim()
        };
        return JSON.stringify(result);
      } catch (e) {
        console.error(`[${this.name}] Error stringifying thinking/answer object:`, e);
        return (answerText || "").trim();
      }
    }
    return (answerText || "").trim();
  }

  _findResponseElementDOM(container) {
    console.log(`[${this.name}] _findResponseElementDOM called on container:`, container);
    if (!container) return null;

    const elements = container.querySelectorAll(this.responseSelectorForDOMFallback);
    if (elements.length > 0) {
      const lastElement = elements[elements.length - 1];
      console.log(`[${this.name}] Found last response element via DOM:`, lastElement);
      if (lastElement.textContent && lastElement.textContent.trim() !== this.lastSentMessage) {
        return lastElement;
      }
    }
    console.log(`[${this.name}] No suitable response element found via DOM in container.`);
    return null;
  }

  shouldSkipResponseMonitoring() {
    return this.captureMethod === "debugger";
  }

  _isResponseStillGeneratingDOM() {
    const thinkingIndicator = document.querySelector(this.thinkingIndicatorSelectorForDOM);
    if (thinkingIndicator) {
      return true;
    }
    return false;
  }

  getStreamingApiPatterns() {
    console.log(`[${this.name}] getStreamingApiPatterns called. Capture method: ${this.captureMethod}`);
    if (this.captureMethod === "debugger" && this.debuggerUrlPattern) {
      console.log(`[${this.name}] Using debugger URL pattern: ${this.debuggerUrlPattern}`);
      return [{ urlPattern: this.debuggerUrlPattern, requestStage: "Response" }];
    }
    console.log(`[${this.name}] No debugger patterns to return (captureMethod is not 'debugger' or no pattern set).`);
    return [];
  }

  _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] DOM Fallback: _startDOMMonitoring for requestId: ${requestId}`);
    this._stopDOMMonitoring();

    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) {
      console.error(`[${this.name}] DOM Fallback: No callback for requestId ${requestId} in _startDOMMonitoring.`);
      return;
    }

    let attempts = 0;
    const maxAttempts = 15;
    const interval = 1000;

    this.domMonitorTimer = setInterval(() => {
      console.log(`[${this.name}] DOM Fallback: Polling attempt ${attempts + 1}/${maxAttempts} for requestId: ${requestId}`);
      const responseData = this._captureResponseDOM();

      if (responseData.found && responseData.text.trim() !== "") {
        console.log(`[${this.name}] DOM Fallback: Response captured for requestId ${requestId}. Text (first 100): ${responseData.text.substring(0, 100)}`);
        this._stopDOMMonitoring();
        callback(requestId, responseData.text, true);
        this.pendingResponseCallbacks.delete(requestId);
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          console.warn(`[${this.name}] DOM Fallback: Max attempts reached for requestId ${requestId}. No response captured.`);
          this._stopDOMMonitoring();
          callback(requestId, "[Error: Timed out waiting for DOM response]", true);
          this.pendingResponseCallbacks.delete(requestId);
        }
      }
    }, interval);
    console.log(`[${this.name}] DOM Fallback: Monitoring started with timer ID ${this.domMonitorTimer}`);
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      console.log(`[${this.name}] DOM Fallback: Stopping DOM monitoring timer ID ${this.domMonitorTimer}`);
      clearInterval(this.domMonitorTimer);
      this.domMonitorTimer = null;
    }
  }
}

if (window.providerUtils) {
  const providerInstance = new AIStudioProvider();
  window.providerUtils.registerProvider(
    providerInstance.name,
    providerInstance.supportedDomains,
    providerInstance
  );
} else {
  console.error("AIStudioProvider: providerUtils not found. Registration failed.");
}
