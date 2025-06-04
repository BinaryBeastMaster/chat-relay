
const CS_LOG_PREFIX = '[CS CONTENT]';
console.log(CS_LOG_PREFIX, "Content Script Injected & Loaded");

let provider = null;
let setupComplete = false;
let currentRequestId = null;
let processingMessage = false;
let responseMonitoringTimers = [];
let captureAttempts = 0;
const MAX_CAPTURE_ATTEMPTS = 30;
const CAPTURE_DELAY = 1000;

function findPotentialSelectors() {
  console.log(CS_LOG_PREFIX, "Searching for potential input fields and buttons...");

  const textareas = document.querySelectorAll('textarea');
  console.log(CS_LOG_PREFIX, "Found textareas:", textareas.length);
  textareas.forEach((textarea, index) => {
    console.log(CS_LOG_PREFIX, `Textarea ${index}:`, {
      id: textarea.id,
      className: textarea.className,
      ariaLabel: textarea.getAttribute('aria-label'),
      placeholder: textarea.getAttribute('placeholder'),
      name: textarea.name
    });
  });

  const inputs = document.querySelectorAll('input[type="text"]');
  console.log(CS_LOG_PREFIX, "Found text inputs:", inputs.length);
  inputs.forEach((input, index) => {
    console.log(CS_LOG_PREFIX, `Input ${index}:`, {
      id: input.id,
      className: input.className,
      ariaLabel: input.getAttribute('aria-label'),
      placeholder: input.getAttribute('placeholder'),
      name: input.name
    });
  });

  const buttons = document.querySelectorAll('button');
  console.log(CS_LOG_PREFIX, "Found buttons:", buttons.length);
  buttons.forEach((button, index) => {
    console.log(CS_LOG_PREFIX, `Button ${index}:`, {
      id: button.id,
      className: button.className,
      ariaLabel: button.getAttribute('aria-label'),
      textContent: button.textContent.trim()
    });
  });
}

function initializeContentRelay() {
  if (setupComplete) {
    console.log(CS_LOG_PREFIX, "Initialization already attempted or complete.");
    return;
  }
  console.log(CS_LOG_PREFIX, 'Initializing content relay...');

  if (window.providerUtils) {
    const detectedProvider = window.providerUtils.detectProvider(window.location.hostname);
    provider = detectedProvider;

    console.log(CS_LOG_PREFIX, 'Detected provider:', provider ? provider.name : 'None');

    if (provider && typeof provider.getStreamingApiPatterns === 'function') {
      const patternsFromProvider = provider.getStreamingApiPatterns();
      console.log(CS_LOG_PREFIX, 'Retrieved patterns from provider:', patternsFromProvider);

      if (patternsFromProvider && patternsFromProvider.length > 0) {
        chrome.runtime.sendMessage({
          type: "SET_DEBUGGER_TARGETS",
          providerName: provider.name,
          patterns: patternsFromProvider
        }, response => {
          if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending SET_DEBUGGER_TARGETS:', chrome.runtime.lastError.message);
          } else {
            console.log(CS_LOG_PREFIX, 'SET_DEBUGGER_TARGETS message sent, response:', response);
          }
        });
      } else {
        console.log(CS_LOG_PREFIX, 'No patterns returned by provider or patterns array is empty.');
      }
    } else {
      if (provider) {
        console.log(CS_LOG_PREFIX, `Provider '${provider.name}' found, but getStreamingApiPatterns method is missing or not a function.`);
      } else {
        console.log(CS_LOG_PREFIX, 'No current provider instance found to get patterns from.');
      }
    }
  } else {
    console.error(CS_LOG_PREFIX, 'providerUtils not found. Cannot detect provider or send patterns.');
  }

  chrome.runtime.sendMessage({
    type: "CHAT_RELAY_READY",
    chatInterface: provider ? provider.name : "unknown"
  }, response => {
    if (chrome.runtime.lastError) {
      console.error(CS_LOG_PREFIX, 'Error sending CHAT_RELAY_READY:', chrome.runtime.lastError.message);
    } else {
      console.log(CS_LOG_PREFIX, 'CHAT_RELAY_READY message sent, response:', response);
    }
  });


  if (provider) {
    console.log(CS_LOG_PREFIX, `Proceeding with provider-specific setup for: ${provider.name}`);
    setTimeout(() => {
      if (!setupComplete) {
        findPotentialSelectors();
        setupAutomaticResponseCapture();
        startElementPolling();
        console.log(CS_LOG_PREFIX, "Provider-specific DOM setup (response capture, polling) initiated after delay.");
      }
    }, 2000);
  } else {
    console.warn(CS_LOG_PREFIX, "No provider detected. Some provider-specific features (response capture, element polling) will not be initialized.");
  }

  setupComplete = true;
  console.log(CS_LOG_PREFIX, "Content relay initialization sequence finished.");
}

function startElementPolling() {
  if (!provider) {
    console.warn(CS_LOG_PREFIX, "Cannot start element polling: no provider detected.");
    return;
  }
  console.log(CS_LOG_PREFIX, "Starting element polling...");

  const pollingInterval = setInterval(() => {
    if (!provider) {
      clearInterval(pollingInterval);
      console.warn(CS_LOG_PREFIX, "Stopping element polling: provider became unavailable.");
      return;
    }
    const inputField = document.querySelector(provider.inputSelector);
    const sendButton = document.querySelector(provider.sendButtonSelector);

    if (inputField) {
      console.log(CS_LOG_PREFIX, "Found input field:", inputField);
    }

    if (sendButton) {
      console.log(CS_LOG_PREFIX, "Found send button:", sendButton);
    }

    if (inputField && sendButton) {
      console.log(CS_LOG_PREFIX, "Found all required elements, stopping polling");
      clearInterval(pollingInterval);
    }
  }, 2000);
}

function sendChatMessage(text) {
  if (!provider) {
    console.error(CS_LOG_PREFIX, "Cannot send chat message: No provider configured.");
    processingMessage = false;
    return false;
  }
  return sendChatMessageWithRetry(text, 5);
}

function sendChatMessageWithRetry(text, maxRetries, currentRetry = 0) {
  if (!provider) {
    console.error(CS_LOG_PREFIX, `Cannot send chat message with retry (attempt ${currentRetry + 1}/${maxRetries}): No provider.`);
    processingMessage = false;
    return false;
  }
  try {
    const inputField = document.querySelector(provider.inputSelector);
    if (!inputField) {
      console.log(CS_LOG_PREFIX, `Could not find input field (attempt ${currentRetry + 1}/${maxRetries})`);
      if (currentRetry < maxRetries - 1) {
        console.log(CS_LOG_PREFIX, `Retrying in 1 second...`);
        setTimeout(() => {
          sendChatMessageWithRetry(text, maxRetries, currentRetry + 1);
        }, 1000);
        return true;
      }
      console.error(CS_LOG_PREFIX, "Could not find input field after all retries");
      processingMessage = false;
      return false;
    }

    const sendButton = document.querySelector(provider.sendButtonSelector);
    if (!sendButton) {
      console.log(CS_LOG_PREFIX, `Could not find send button (attempt ${currentRetry + 1}/${maxRetries})`);
      if (currentRetry < maxRetries - 1) {
        console.log(CS_LOG_PREFIX, `Retrying in 1 second...`);
        setTimeout(() => {
          sendChatMessageWithRetry(text, maxRetries, currentRetry + 1);
        }, 1000);
        return true;
      }
      console.error(CS_LOG_PREFIX, "Could not find send button after all retries");
      processingMessage = false;
      return false;
    }

    const result = provider.sendChatMessage(text, inputField, sendButton);

    if (result) {
      console.log(CS_LOG_PREFIX, "Message sent successfully via provider.");
      if (provider.shouldSkipResponseMonitoring && provider.shouldSkipResponseMonitoring()) {
        console.log(CS_LOG_PREFIX, `Provider ${provider.name} has requested to skip response monitoring.`);
        processingMessage = false;
      } else {
        console.log(CS_LOG_PREFIX, `Waiting ${CAPTURE_DELAY / 1000} seconds before starting to monitor for responses...`);
        const timer = setTimeout(() => {
          console.log(CS_LOG_PREFIX, "Starting to monitor for responses now");
          startMonitoringForResponse();
        }, CAPTURE_DELAY);
        responseMonitoringTimers.push(timer);
      }
    } else {
      console.error(CS_LOG_PREFIX, "Provider reported failure sending message.");
      processingMessage = false;
    }
    return result;
  } catch (error) {
    console.error(CS_LOG_PREFIX, "Error sending message:", error);
    if (currentRetry < maxRetries - 1) {
      console.log(CS_LOG_PREFIX, `Error occurred, retrying in 1 second... (attempt ${currentRetry + 1}/${maxRetries})`);
      setTimeout(() => {
        sendChatMessageWithRetry(text, maxRetries, currentRetry + 1);
      }, 1000);
      return true;
    }
    processingMessage = false;
    return false;
  }
}

function startMonitoringForResponse() {
  if (!provider || !provider.responseSelector || !provider.getResponseText) {
    console.error(CS_LOG_PREFIX, "Cannot monitor for response: Provider or necessary provider methods/selectors are not configured.");
    processingMessage = false;
    return;
  }

  console.log(CS_LOG_PREFIX, "Starting response monitoring process...");
  captureAttempts = 0;

  const attemptCapture = () => {
    if (!processingMessage && currentRequestId === null) {
      console.log(CS_LOG_PREFIX, "Response monitoring stopped because processingMessage is false and currentRequestId is null (likely request completed or cancelled).");
      return;
    }

    if (captureAttempts >= MAX_CAPTURE_ATTEMPTS) {
      console.error(CS_LOG_PREFIX, "Maximum response capture attempts reached. Stopping monitoring.");
      if (currentRequestId !== null) {
        chrome.runtime.sendMessage({
          type: "FINAL_RESPONSE_TO_RELAY",
          requestId: currentRequestId,
          error: "Response capture timed out in content script.",
          isFinal: true
        }, response => {
          if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending capture timeout error:', chrome.runtime.lastError.message);
          } else {
            console.log(CS_LOG_PREFIX, 'Capture timeout error sent to background, response:', response);
          }
        });
      }
      processingMessage = false;
      currentRequestId = null;
      return;
    }

    captureAttempts++;
    console.log(CS_LOG_PREFIX, `Response capture attempt ${captureAttempts}/${MAX_CAPTURE_ATTEMPTS}`);

    const responseElement = document.querySelector(provider.responseSelector);
    if (responseElement) {
      const responseText = provider.getResponseText(responseElement);
      const isFinal = provider.isResponseComplete ? provider.isResponseComplete(responseElement) : false;

      console.log(CS_LOG_PREFIX, `Captured response text (length: ${responseText.length}), isFinal: ${isFinal}`);

      chrome.runtime.sendMessage({
        type: "FINAL_RESPONSE_TO_RELAY",
        requestId: currentRequestId,
        text: responseText,
        isFinal: isFinal
      }, response => {
        if (chrome.runtime.lastError) {
          console.error(CS_LOG_PREFIX, 'Error sending response data to background:', chrome.runtime.lastError.message);
        } else {
          console.log(CS_LOG_PREFIX, 'Response data sent to background, response:', response);
        }
      });

      if (isFinal) {
        console.log(CS_LOG_PREFIX, "Final response detected. Stopping monitoring.");
        processingMessage = false;
        return;
      }
    } else {
      console.log(CS_LOG_PREFIX, "Response element not found yet.");
    }

    const timer = setTimeout(attemptCapture, CAPTURE_DELAY);
    responseMonitoringTimers.push(timer);
  };

  attemptCapture();
}


function setupAutomaticResponseCapture() {
  if (!provider || !provider.responseContainerSelector || typeof provider.handleMutation !== 'function') {
    console.warn(CS_LOG_PREFIX, "Cannot set up automatic response capture: Provider or necessary provider methods/selectors are not configured.");
    return;
  }

  console.log(CS_LOG_PREFIX, "Setting up MutationObserver for automatic response capture on selector:", provider.responseContainerSelector);

  const targetNode = document.querySelector(provider.responseContainerSelector);

  if (!targetNode) {
    console.warn(CS_LOG_PREFIX, `Response container element ('${provider.responseContainerSelector}') not found. MutationObserver not started. Will rely on polling or debugger.`);
    return;
  }

  const config = { childList: true, subtree: true, characterData: true };

  const callback = (mutationsList, observer) => {
    if (!processingMessage || currentRequestId === null) {
      return;
    }

    try {
      provider.handleMutation(mutationsList, observer, currentRequestId, handleProviderResponse);
    } catch (e) {
      console.error(CS_LOG_PREFIX, "Error in provider.handleMutation:", e);
    }
  };

  const observer = new MutationObserver(callback);

  try {
    observer.observe(targetNode, config);
    console.log(CS_LOG_PREFIX, "MutationObserver started on:", targetNode);
  } catch (e) {
    console.error(CS_LOG_PREFIX, "Failed to start MutationObserver:", e, "on target:", targetNode);
  }

}


function monitorResponseCompletion(element) {
  if (!provider || !provider.thinkingIndicatorSelector) {
    console.warn(CS_LOG_PREFIX, "Cannot monitor response completion: No thinkingIndicatorSelector in provider.");
    return;
  }

  const thinkingIndicator = document.querySelector(provider.thinkingIndicatorSelector);
  if (!thinkingIndicator) {
    console.log(CS_LOG_PREFIX, "Thinking indicator not found, assuming response is complete or was never present.");
    return;
  }

  console.log(CS_LOG_PREFIX, "Thinking indicator found. Monitoring for its removal...");
  const observer = new MutationObserver((mutationsList, obs) => {

    if (!document.body.contains(thinkingIndicator)) {
      console.log(CS_LOG_PREFIX, "Thinking indicator removed. Assuming response completion.");
      obs.disconnect();
      captureResponse(null, true);
    }
  });

  if (thinkingIndicator.parentNode) {
    observer.observe(thinkingIndicator.parentNode, { childList: true, subtree: true });
  } else {
    console.warn(CS_LOG_PREFIX, "Thinking indicator has no parent node to observe. Cannot monitor for removal effectively.");
  }
}

function monitorGeminiResponse(element) {
  console.log(CS_LOG_PREFIX, "Monitoring Gemini response element:", element);
  const observer = new MutationObserver((mutationsList, obs) => {
    let isComplete = false;

    if (isComplete) {
      console.log(CS_LOG_PREFIX, "Gemini response detected as complete by mutation.");
      obs.disconnect();
      captureResponse(element, true);
    }
  });
  observer.observe(element, { attributes: true, childList: true, subtree: true });
  console.log(CS_LOG_PREFIX, "Gemini response observer started.");
}

function monitorGeminiContentStability(element) {
  let lastContent = "";
  let stableCount = 0;
  const STABLE_THRESHOLD = 3;
  const CHECK_INTERVAL = 300;

  console.log(CS_LOG_PREFIX, "Starting Gemini content stability monitoring for element:", element);

  const intervalId = setInterval(() => {
    if (!processingMessage || currentRequestId === null) {
      console.log(CS_LOG_PREFIX, "Gemini stability: Stopping, no longer processing message.");
      clearInterval(intervalId);
      return;
    }

    const currentContent = provider.getResponseText(element);
    if (currentContent === lastContent) {
      stableCount++;
      console.log(CS_LOG_PREFIX, `Gemini stability: Content stable, count: ${stableCount}`);
    } else {
      lastContent = currentContent;
      stableCount = 0;
      console.log(CS_LOG_PREFIX, `Gemini stability: Content changed. New length: ${currentContent.length}`);
      if (provider.sendPartialUpdates) {
        handleProviderResponse(currentRequestId, currentContent, false);
      }
    }

    if (stableCount >= STABLE_THRESHOLD) {
      console.log(CS_LOG_PREFIX, "Gemini stability: Content stable for threshold. Assuming final.");
      clearInterval(intervalId);
      const finalContent = provider.getResponseText(element);
      handleProviderResponse(currentRequestId, finalContent, true);
    }
  }, CHECK_INTERVAL);
  responseMonitoringTimers.push(intervalId);
}


function captureResponse(potentialTurnElement = null, isFinal = false) {
  if (!provider || !provider.getResponseText) {
    console.error(CS_LOG_PREFIX, "Cannot capture response: No provider or getResponseText method.");
    if (currentRequestId !== null) {
      handleProviderResponse(currentRequestId, "Error: Provider misconfiguration for response capture.", true);
    }
    return;
  }

  let responseElement = null;
  if (potentialTurnElement && typeof potentialTurnElement === 'object' && potentialTurnElement.nodeType === 1) {
    responseElement = potentialTurnElement;
    console.log(CS_LOG_PREFIX, "Using provided potentialTurnElement for capture:", responseElement);
  } else {
    if (!provider.responseSelector) {
      console.error(CS_LOG_PREFIX, "Cannot capture response: No responseSelector in provider and no valid potentialTurnElement given.");
      if (currentRequestId !== null) {
        handleProviderResponse(currentRequestId, "Error: Provider responseSelector missing.", true);
      }
      return;
    }
    responseElement = document.querySelector(provider.responseSelector);
    console.log(CS_LOG_PREFIX, "Using provider.responseSelector for capture:", provider.responseSelector);
  }

  if (!responseElement) {
    console.warn(CS_LOG_PREFIX, "Response element not found during capture.");
    if (isFinal && currentRequestId !== null) {
      handleProviderResponse(currentRequestId, "Error: Response element not found for final capture.", true);
    }
    return;
  }

  const responseText = provider.getResponseText(responseElement);
  const trulyFinal = isFinal || (provider.isResponseComplete ? provider.isResponseComplete(responseElement) : false);

  console.log(CS_LOG_PREFIX, `Captured response (length: ${responseText.length}), isFinal: ${trulyFinal}. Passed isFinal: ${isFinal}`);

  if (currentRequestId === null) {
    console.warn(CS_LOG_PREFIX, "captureResponse: currentRequestId is null. Cannot send response to background.");
    return;
  }

  handleProviderResponse(currentRequestId, responseText, trulyFinal);
}

function clearResponseMonitoringTimers() {
  console.log(CS_LOG_PREFIX, `Clearing ${responseMonitoringTimers.length} response monitoring timers.`);
  responseMonitoringTimers.forEach(timerId => clearTimeout(timerId));
  responseMonitoringTimers = [];
}

function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "SEND_CHAT_MESSAGE") {
      const messageContent = message.messageContent;
      let messagePreview = "";
      if (typeof messageContent === 'string') {
        messagePreview = `String: "${messageContent.substring(0, 50)}..."`;
      } else if (messageContent instanceof ArrayBuffer) {
        messagePreview = `ArrayBuffer data (size: ${messageContent.byteLength} bytes)`;
      } else if (messageContent instanceof Blob) {
        messagePreview = `Blob data (size: ${messageContent.size} bytes, type: ${messageContent.type})`;
      } else if (messageContent && typeof messageContent === 'object' && messageContent !== null) {
        messagePreview = `Object data (type: ${Object.prototype.toString.call(messageContent)})`;
      } else {
        messagePreview = `Data type: ${typeof messageContent}, Value: ${String(messageContent).substring(0, 50)}`;
      }
      console.log(CS_LOG_PREFIX, "Received command to send message:", messagePreview, "Request ID:", message.requestId, "Last Processed Text:", message.lastProcessedText ? `"${message.lastProcessedText.substring(0, 50)}..."` : "null");

      if (!provider) {
        console.error(CS_LOG_PREFIX, "Cannot send message: No provider detected.");
        sendResponse({ success: false, error: "No provider detected" });
        return true;
      }

      if (processingMessage && currentRequestId !== null && currentRequestId !== message.requestId) {
        console.warn(CS_LOG_PREFIX, `New message (requestId: ${message.requestId}) received while request ${currentRequestId} was processing. The new message will supersede the old one.`);
        clearResponseMonitoringTimers();
        processingMessage = false;
        currentRequestId = null;
      } else if (processingMessage && currentRequestId === message.requestId) {
        console.warn(CS_LOG_PREFIX, `Received duplicate SEND_CHAT_MESSAGE for already processing requestId: ${message.requestId}. Ignoring duplicate command.`);
        sendResponse({ success: false, error: "Duplicate command for already processing requestId." });
        return true;
      }

      const inputField = document.querySelector(provider.inputSelector);
      let currentUIInputText = null;

      if (inputField) {
        currentUIInputText = inputField.value;
      } else {
        console.error(CS_LOG_PREFIX, "Input field not found via selector:", provider.inputSelector, "Cannot process SEND_CHAT_MESSAGE for requestId:", message.requestId);
        if (currentRequestId === message.requestId) {
          processingMessage = false;
        }
        sendResponse({ success: false, error: "Input field not found by content script." });
        return true;
      }

      let isDuplicateMessageScenario = false;
      if (typeof messageContent === 'string' && typeof message.lastProcessedText === 'string' && typeof currentUIInputText === 'string') {
        isDuplicateMessageScenario = message.lastProcessedText &&
          messageContent === message.lastProcessedText &&
          currentUIInputText === messageContent;
      }

      if (isDuplicateMessageScenario) {
        console.log(CS_LOG_PREFIX, `Duplicate message scenario detected for requestId: ${message.requestId}.`);
        console.log(CS_LOG_PREFIX, `  Server wants to send: "${messageContent.substring(0, 50)}..."`);
        console.log(CS_LOG_PREFIX, `  Last processed text was: "${message.lastProcessedText.substring(0, 50)}..."`);
        console.log(CS_LOG_PREFIX, `  Current UI input is: "${currentUIInputText.substring(0, 50)}..."`);

        console.log(CS_LOG_PREFIX, "Clearing input field and notifying background.");
        inputField.value = '';

        chrome.runtime.sendMessage({
          type: "DUPLICATE_MESSAGE_HANDLED",
          requestId: message.requestId,
          originalText: messageContent
        }, response => {
          if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending DUPLICATE_MESSAGE_HANDLED:', chrome.runtime.lastError.message);
          } else {
            console.log(CS_LOG_PREFIX, 'DUPLICATE_MESSAGE_HANDLED sent to background, response:', response);
          }
        });

        if (currentRequestId === message.requestId) {
          processingMessage = false;
          currentRequestId = null;
        }

        sendResponse({ success: true, message: "Duplicate message scenario handled by clearing input." });
        return true;
      }

      console.log(CS_LOG_PREFIX, `Not a duplicate scenario for requestId: ${message.requestId}. Proceeding to send.`);
      processingMessage = true;
      currentRequestId = message.requestId;
      console.log(CS_LOG_PREFIX, `Set currentRequestId to ${currentRequestId} for processing.`);

      if (provider && typeof provider.sendChatMessage === 'function') {
        provider.sendChatMessage(messageContent, currentRequestId)
          .then(success => {
            if (success) {
              console.log(CS_LOG_PREFIX, `Message sending initiated successfully via provider for requestId: ${currentRequestId}.`);
              if (provider.initiateResponseCapture && typeof provider.initiateResponseCapture === 'function') {
                console.log(CS_LOG_PREFIX, `Calling provider.initiateResponseCapture for requestId: ${currentRequestId}`);
                provider.initiateResponseCapture(currentRequestId, handleProviderResponse);
              } else {
                console.error(CS_LOG_PREFIX, `Provider ${provider.name} does not have initiateResponseCapture method. Response will not be processed for requestId ${currentRequestId}.`);
                chrome.runtime.sendMessage({
                  type: "FINAL_RESPONSE_TO_RELAY",
                  requestId: currentRequestId,
                  error: `Provider ${provider.name} cannot capture responses. Message sent but no response will be relayed.`,
                  isFinal: true
                });
                processingMessage = false;
                currentRequestId = null;
              }
              sendResponse({ success: true, message: "Message sending initiated by provider." });
            } else {
              console.error(CS_LOG_PREFIX, `Provider failed to initiate sending message for requestId: ${currentRequestId}.`);
              processingMessage = false;
              currentRequestId = null;
              sendResponse({ success: false, error: "Provider failed to send message." });
            }
          }).catch(error => {
            console.error(CS_LOG_PREFIX, `Error during provider.sendChatMessage for requestId: ${currentRequestId}:`, error);
            processingMessage = false;
            currentRequestId = null;
            sendResponse({ success: false, error: `Error sending message: ${error.message}` });
          });
      } else {
        console.error(CS_LOG_PREFIX, "Provider or provider.sendChatMessage is not available for requestId:", message.requestId);
        processingMessage = false;
        currentRequestId = null;
        sendResponse({ success: false, error: "Provider or sendChatMessage method missing." });
      }
      return true;
    } else if (message.type === "DEBUGGER_RESPONSE") {
      console.log(CS_LOG_PREFIX, "Received DEBUGGER_RESPONSE message object:", JSON.stringify(message));
      console.log(CS_LOG_PREFIX, `Processing DEBUGGER_RESPONSE for app requestId: ${currentRequestId}. Debugger requestId: ${message.requestId}. Data length: ${message.data ? message.data.length : 'null'}`);
      if (!provider) {
        console.error(CS_LOG_PREFIX, "Received DEBUGGER_RESPONSE but no provider is active.");
        sendResponse({ success: false, error: "No provider active." });
        return true;
      }
      if (typeof provider.handleDebuggerData !== 'function') {
        console.error(CS_LOG_PREFIX, `Provider ${provider.name} does not implement handleDebuggerData.`);
        sendResponse({ success: false, error: `Provider ${provider.name} does not support debugger method.` });
        return true;
      }

      if (!message.requestId && message.requestId !== 0) {
        console.error(CS_LOG_PREFIX, `Received DEBUGGER_RESPONSE without a valid message.requestId. Ignoring. Message:`, message);
        sendResponse({ success: false, error: "DEBUGGER_RESPONSE missing requestId." });
        return true;
      }

      console.log(CS_LOG_PREFIX, `Calling provider.handleDebuggerData for requestId: ${message.requestId} with isFinal: ${message.isFinal}`);
      provider.handleDebuggerData(message.requestId, message.data, message.isFinal, handleProviderResponse);
      sendResponse({ success: true, message: "Debugger data passed to provider." });
      return true;

    } else if (message.type === "PING_TAB") {
      console.log(CS_LOG_PREFIX, "Received PING_TAB from background script.");
      sendResponse({ success: true, message: "PONG" });
      return true;
    } else if (message.action === "STOP_STREAMING") {
      console.log(CS_LOG_PREFIX, `Received STOP_STREAMING command for requestId: ${message.requestId}`);
      if (provider && typeof provider.stopStreaming === 'function') {
        provider.stopStreaming(message.requestId);
        if (currentRequestId === message.requestId) {
          processingMessage = false;
          currentRequestId = null;
          clearResponseMonitoringTimers();
          console.log(CS_LOG_PREFIX, `STOP_STREAMING: Cleared active currentRequestId ${message.requestId} and processingMessage flag.`);
        }
        sendResponse({ success: true, message: `Streaming stopped for requestId: ${message.requestId}` });
      } else {
        console.error(CS_LOG_PREFIX, "Provider or provider.stopStreaming is not available for STOP_STREAMING command.");
        sendResponse({ success: false, error: "Provider or stopStreaming method missing." });
      }
      return true;
    }


    console.log(CS_LOG_PREFIX, "Unhandled message type received:", message.type || message.action);
  });
}

function handleProviderResponse(requestId, responseText, isFinal) {
  console.log(CS_LOG_PREFIX, `handleProviderResponse called for requestId: ${requestId}. Data length: ${responseText ? String(responseText).length : 'null'}. isFinal: ${isFinal}. Data (first 100 chars): '${(responseText || "").substring(0, 100)}', Type: ${typeof responseText}`);

  if (currentRequestId !== requestId && currentRequestId !== null) {
    console.warn(CS_LOG_PREFIX, `handleProviderResponse: content.js currentRequestId (${currentRequestId}) differs from provider's response requestId (${requestId}). Proceeding with provider's requestId for data relay.`);
  }

  if (chrome.runtime && chrome.runtime.sendMessage) {
    const MAX_RESPONSE_TEXT_LENGTH = 500 * 1024;
    let messageToSendToBackground;

    // Encode special Unicode characters before transmission
    const encodedText = responseText ? encodeURIComponent(responseText) : "";
    
    if (responseText && typeof responseText === 'string' && responseText.length > MAX_RESPONSE_TEXT_LENGTH) {
      console.warn(CS_LOG_PREFIX, `ResponseText for requestId ${requestId} is too large (${responseText.length} bytes). Sending error and truncated text.`);
      messageToSendToBackground = {
        type: "FINAL_RESPONSE_TO_RELAY",
        requestId: requestId,
        error: `Response too large to transmit (length: ${responseText.length}). Check content script logs for truncated version.`,
        text: `Error: Response too large (length: ${responseText.length}). See AI Studio for full response.`,
        isFinal: true,
        encoded: true
      };
    } else {
      messageToSendToBackground = {
        type: "FINAL_RESPONSE_TO_RELAY",
        requestId: requestId,
        text: encodedText,
        isFinal: isFinal,
        encoded: true
      };
    }

    console.log(CS_LOG_PREFIX, `[REQ-${requestId}] PRE-SEND to BG: Type: ${messageToSendToBackground.type}, isFinal: ${messageToSendToBackground.isFinal}, HasError: ${!!messageToSendToBackground.error}, TextLength: ${messageToSendToBackground.text ? String(messageToSendToBackground.text).length : (messageToSendToBackground.error ? String(messageToSendToBackground.error).length : 'N/A')}`);
    try {
      chrome.runtime.sendMessage(messageToSendToBackground, response => {
        if (chrome.runtime.lastError) {
          console.error(CS_LOG_PREFIX, `[REQ-${requestId}] SEND FAILED to BG: ${chrome.runtime.lastError.message}. Message attempted:`, JSON.stringify(messageToSendToBackground).substring(0, 500));
        } else {
          console.log(CS_LOG_PREFIX, `[REQ-${requestId}] SEND SUCCESS to BG. Ack from BG:`, response);
        }
      });
    } catch (syncError) {
      console.error(CS_LOG_PREFIX, `[REQ-${requestId}] SYNC ERROR sending to BG: ${syncError.message}. Message attempted:`, JSON.stringify(messageToSendToBackground).substring(0, 500), syncError);
    }
  } else {
    console.error(CS_LOG_PREFIX, "Cannot send FINAL_RESPONSE_TO_RELAY, runtime is invalid.");
  }

  if (isFinal) {
    if (currentRequestId === requestId) {
      processingMessage = false;
      currentRequestId = null;
      clearResponseMonitoringTimers();
      console.log(CS_LOG_PREFIX, `Processing finished for active requestId: ${requestId}. State reset in content.js.`);
    } else {
      console.log(CS_LOG_PREFIX, `Processing finished for requestId: ${requestId}. This was not the active content.js requestId (${currentRequestId}), so content.js state not altered by this finalization. However, timers for ${requestId} might need explicit cleanup if any were started by it.`);
    }
  } else {
    console.log(CS_LOG_PREFIX, `Partial response processed for requestId: ${requestId}. Awaiting more data or final flag.`);
  }
}


if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", attemptInitialization);
} else {
  attemptInitialization();
}

function attemptInitialization() {
  console.log(CS_LOG_PREFIX, "Attempting initialization...");
  if (window.attemptedInitialization) {
    console.log(CS_LOG_PREFIX, "Initialization already attempted. Skipping.");
    return;
  }
  window.attemptedInitialization = true;
  initializeContentRelay();
  setupMessageListeners();
  console.log(CS_LOG_PREFIX, "Initialization attempt complete. Message listeners set up.");
}
