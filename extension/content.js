/*
 * Chat Relay: Relay for AI Chat Interfaces
 * Copyright (C) 2025 Jamison Moore
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see https://www.gnu.org/licenses/.
 */
// AI Chat Relay - Content Script

// Prefix for console logs
const CS_LOG_PREFIX = '[CS CONTENT]';
console.log(CS_LOG_PREFIX, "Content Script Injected & Loaded");

// Global state
let provider = null; // This will be set by initializeContentRelay
let setupComplete = false;
let currentRequestId = null;
let processingMessage = false; // Flag to track if we're currently processing a message
let responseMonitoringTimers = []; // Keep track of all monitoring timers
let captureAttempts = 0; // Track how many capture attempts we've made
const MAX_CAPTURE_ATTEMPTS = 30; // Maximum number of capture attempts
const CAPTURE_DELAY = 1000; // 1 second between capture attempts

// Helper function to find potential input fields and buttons
function findPotentialSelectors() {
  console.log(CS_LOG_PREFIX, "Searching for potential input fields and buttons...");
  
  // Find all textareas
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
  
  // Find all input fields
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
  
  // Find all buttons
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

    // Provider Detection
    if (window.providerUtils) {
        const detectedProvider = window.providerUtils.detectProvider(window.location.hostname); // New detection method
        provider = detectedProvider; // Update the global provider instance

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

    // Send CHAT_RELAY_READY (always, after attempting provider setup)
    chrome.runtime.sendMessage({
      type: "CHAT_RELAY_READY",
      chatInterface: provider ? provider.name : "unknown" // Add provider name
    }, response => {
        if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending CHAT_RELAY_READY:', chrome.runtime.lastError.message);
        } else {
            console.log(CS_LOG_PREFIX, 'CHAT_RELAY_READY message sent, response:', response);
        }
    });
    
    // Setup message listeners (will be called later, once, via setupMessageListeners)

    // If a provider is detected, proceed with provider-specific setup after a delay
    if (provider) {
        console.log(CS_LOG_PREFIX, `Proceeding with provider-specific setup for: ${provider.name}`);
        setTimeout(() => {
            // Double check setupComplete flag in case of async issues or rapid calls, though less likely here.
            if (!setupComplete) { 
                findPotentialSelectors(); 
                setupAutomaticResponseCapture(); 
                startElementPolling(); 
                console.log(CS_LOG_PREFIX, "Provider-specific DOM setup (response capture, polling) initiated after delay.");
            }
        }, 2000); // Delay to allow page elements to fully render
    } else {
        console.warn(CS_LOG_PREFIX, "No provider detected. Some provider-specific features (response capture, element polling) will not be initialized.");
    }
    
    setupComplete = true; 
    console.log(CS_LOG_PREFIX, "Content relay initialization sequence finished.");
}

// Poll for elements that might be loaded dynamically
function startElementPolling() {
  if (!provider) {
    console.warn(CS_LOG_PREFIX, "Cannot start element polling: no provider detected.");
    return;
  }
  console.log(CS_LOG_PREFIX, "Starting element polling...");
  
  // Check every 2 seconds for the input field and send button
  const pollingInterval = setInterval(() => {
    if (!provider) { // Provider might have been lost or was never there
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

// Function to send a message to the chat interface
function sendChatMessage(text) {
  if (!provider) {
    console.error(CS_LOG_PREFIX, "Cannot send chat message: No provider configured.");
    processingMessage = false; // Reset flag
    return false;
  }
  // Try to send the message with retries
  return sendChatMessageWithRetry(text, 5); // Try up to 5 times
}

// Helper function to send a message with retries
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
            processingMessage = false; // Message sent, no monitoring, so reset.
        } else {
            console.log(CS_LOG_PREFIX, `Waiting ${CAPTURE_DELAY/1000} seconds before starting to monitor for responses...`);
            const timer = setTimeout(() => {
                console.log(CS_LOG_PREFIX, "Starting to monitor for responses now");
                startMonitoringForResponse();
            }, CAPTURE_DELAY);
            responseMonitoringTimers.push(timer);
        }
    } else {
        console.error(CS_LOG_PREFIX, "Provider reported failure sending message.");
        processingMessage = false; // Reset on failure
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

// Function to start monitoring for a response
function startMonitoringForResponse() {
  if (!provider || !provider.responseSelector || !provider.getResponseText) {
    console.error(CS_LOG_PREFIX, "Cannot monitor for response: Provider or necessary provider methods/selectors are not configured.");
    processingMessage = false; // Can't monitor, so reset.
    return;
  }

  console.log(CS_LOG_PREFIX, "Starting response monitoring process...");
  captureAttempts = 0; // Reset capture attempts for this new monitoring session

  const attemptCapture = () => {
    if (!processingMessage && currentRequestId === null) {
      console.log(CS_LOG_PREFIX, "Response monitoring stopped because processingMessage is false and currentRequestId is null (likely request completed or cancelled).");
      return; // Stop if no longer processing a message
    }
    
    if (captureAttempts >= MAX_CAPTURE_ATTEMPTS) {
      console.error(CS_LOG_PREFIX, "Maximum response capture attempts reached. Stopping monitoring.");
      // Send a timeout/error message back to the background script
      if (currentRequestId !== null) { // Ensure there's a request ID to report error for
          chrome.runtime.sendMessage({
              type: "FINAL_RESPONSE_TO_RELAY",
              requestId: currentRequestId,
              error: "Response capture timed out in content script.",
              isFinal: true // Treat as final to unblock server
          }, response => {
              if (chrome.runtime.lastError) {
                  console.error(CS_LOG_PREFIX, 'Error sending capture timeout error:', chrome.runtime.lastError.message);
              } else {
                  console.log(CS_LOG_PREFIX, 'Capture timeout error sent to background, response:', response);
              }
          });
      }
      processingMessage = false;
      currentRequestId = null; // Clear current request ID as it timed out
      return;
    }

    captureAttempts++;
    console.log(CS_LOG_PREFIX, `Response capture attempt ${captureAttempts}/${MAX_CAPTURE_ATTEMPTS}`);

    const responseElement = document.querySelector(provider.responseSelector);
    if (responseElement) {
      const responseText = provider.getResponseText(responseElement);
      const isFinal = provider.isResponseComplete ? provider.isResponseComplete(responseElement) : false; // Default to false if not implemented

      console.log(CS_LOG_PREFIX, `Captured response text (length: ${responseText.length}), isFinal: ${isFinal}`);
      
      // Send to background
      chrome.runtime.sendMessage({
        type: "FINAL_RESPONSE_TO_RELAY", // Or a new type like "PARTIAL_RESPONSE" if needed
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
        processingMessage = false; // Reset flag as processing is complete
        // currentRequestId will be cleared by handleProviderResponse or if a new message comes
        return; 
      }
    } else {
      console.log(CS_LOG_PREFIX, "Response element not found yet.");
    }

    // Continue polling
    const timer = setTimeout(attemptCapture, CAPTURE_DELAY);
    responseMonitoringTimers.push(timer);
  };

  // Initial call to start the process
  attemptCapture();
}


// Function to set up automatic response capture using MutationObserver
function setupAutomaticResponseCapture() {
  if (!provider || !provider.responseContainerSelector || typeof provider.handleMutation !== 'function') {
    console.warn(CS_LOG_PREFIX, "Cannot set up automatic response capture: Provider or necessary provider methods/selectors are not configured.");
    return;
  }

  console.log(CS_LOG_PREFIX, "Setting up MutationObserver for automatic response capture on selector:", provider.responseContainerSelector);

  const targetNode = document.querySelector(provider.responseContainerSelector);

  if (!targetNode) {
    console.warn(CS_LOG_PREFIX, `Response container element ('${provider.responseContainerSelector}') not found. MutationObserver not started. Will rely on polling or debugger.`);
    // Optionally, retry finding the targetNode after a delay, or fall back to polling exclusively.
    // For now, we just warn and don't start the observer.
    return;
  }

  const config = { childList: true, subtree: true, characterData: true };

  const callback = (mutationsList, observer) => {
    // If not processing a message, or no current request, don't do anything.
    // This check is crucial to prevent processing mutations when not expected.
    if (!processingMessage || currentRequestId === null) {
        // console.log(CS_LOG_PREFIX, "MutationObserver: Ignoring mutation, not actively processing a message or no currentRequestId.");
        return;
    }
    
    // Let the provider handle the mutation and decide if it's relevant
    // The provider's handleMutation should call handleProviderResponse with the requestId
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
      // Fallback or error handling if observer cannot be started
  }

  // Store the observer if we need to disconnect it later
  // e.g., window.chatRelayObserver = observer;
}


// Function to monitor for the completion of a response (e.g., when a "thinking" indicator disappears)
// This is a more generic version, specific providers might have more tailored logic.
function monitorResponseCompletion(element) {
  if (!provider || !provider.thinkingIndicatorSelector) {
    console.warn(CS_LOG_PREFIX, "Cannot monitor response completion: No thinkingIndicatorSelector in provider.");
    return;
  }

  const thinkingIndicator = document.querySelector(provider.thinkingIndicatorSelector);
  if (!thinkingIndicator) {
    // If the indicator is already gone, assume completion or it never appeared.
    // Provider's getResponseText should ideally capture the full text.
    console.log(CS_LOG_PREFIX, "Thinking indicator not found, assuming response is complete or was never present.");
    // Potentially call captureResponse one last time if needed by provider logic
    // captureResponse(null, true); // Example, might need adjustment
    return;
  }

  console.log(CS_LOG_PREFIX, "Thinking indicator found. Monitoring for its removal...");
  const observer = new MutationObserver((mutationsList, obs) => {
    // Check if the thinking indicator (or its parent, if it's removed directly) is no longer in the DOM
    // or if a specific class/attribute indicating completion appears.
    // This logic needs to be robust and provider-specific.
    
    // A simple check: if the element itself is removed or a known parent.
    // More complex checks might involve looking for specific classes on the response element.
    if (!document.body.contains(thinkingIndicator)) {
      console.log(CS_LOG_PREFIX, "Thinking indicator removed. Assuming response completion.");
      obs.disconnect();
      // Capture the final response
      // This assumes captureResponse can get the full text now.
      // The 'true' flag indicates this is considered the final capture.
      captureResponse(null, true); 
    }
    // Add other provider-specific checks here if needed
  });

  // Observe the parent of the thinking indicator for changes in its children (e.g., removal of the indicator)
  // Or observe attributes of the indicator itself if it changes state instead of being removed.
  if (thinkingIndicator.parentNode) {
    observer.observe(thinkingIndicator.parentNode, { childList: true, subtree: true });
  } else {
    console.warn(CS_LOG_PREFIX, "Thinking indicator has no parent node to observe. Cannot monitor for removal effectively.");
  }
}

// Specific monitoring for Gemini, if needed (example)
function monitorGeminiResponse(element) {
    // Gemini specific logic for monitoring response element for completion
    // This might involve looking for specific attributes or child elements
    // that indicate the stream has finished.
    console.log(CS_LOG_PREFIX, "Monitoring Gemini response element:", element);
    // Example: Observe for a specific class or attribute change
    const observer = new MutationObserver((mutationsList, obs) => {
        let isComplete = false;
        // Check mutations for signs of completion based on Gemini's DOM structure
        // For instance, a "generating" class is removed, or a "complete" attribute is set.
        // This is highly dependent on the actual Gemini interface.
        // Example (conceptual):
        // if (element.classList.contains('response-complete')) {
        //    isComplete = true;
        // }

        if (isComplete) {
            console.log(CS_LOG_PREFIX, "Gemini response detected as complete by mutation.");
            obs.disconnect();
            captureResponse(element, true); // Capture final response
        }
    });
    observer.observe(element, { attributes: true, childList: true, subtree: true });
    console.log(CS_LOG_PREFIX, "Gemini response observer started.");
}

function monitorGeminiContentStability(element) {
    let lastContent = "";
    let stableCount = 0;
    const STABLE_THRESHOLD = 3; // Number of intervals content must remain unchanged
    const CHECK_INTERVAL = 300; // Milliseconds

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
            stableCount = 0; // Reset if content changes
            console.log(CS_LOG_PREFIX, `Gemini stability: Content changed. New length: ${currentContent.length}`);
            // Send partial update if provider wants it
            if (provider.sendPartialUpdates) {
                 handleProviderResponse(currentRequestId, currentContent, false);
            }
        }

        if (stableCount >= STABLE_THRESHOLD) {
            console.log(CS_LOG_PREFIX, "Gemini stability: Content stable for threshold. Assuming final.");
            clearInterval(intervalId);
            // Ensure the very latest content is captured and sent as final
            const finalContent = provider.getResponseText(element);
            handleProviderResponse(currentRequestId, finalContent, true);
        }
    }, CHECK_INTERVAL);
    responseMonitoringTimers.push(intervalId); // Store to clear if needed
}


// Function to capture the response text
// potentialTurnElement is passed by some providers (like Gemini) if they identify the specific response "turn" element
function captureResponse(potentialTurnElement = null, isFinal = false) {
  if (!provider || !provider.getResponseText) {
    console.error(CS_LOG_PREFIX, "Cannot capture response: No provider or getResponseText method.");
    if (currentRequestId !== null) {
        handleProviderResponse(currentRequestId, "Error: Provider misconfiguration for response capture.", true);
    }
    return;
  }

  // Use the potentialTurnElement if provided and valid, otherwise fall back to provider.responseSelector
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
    // If it's supposed to be final and element is not found, it might be an issue.
    if (isFinal && currentRequestId !== null) {
        handleProviderResponse(currentRequestId, "Error: Response element not found for final capture.", true);
    }
    return;
  }

  const responseText = provider.getResponseText(responseElement);
  // isFinal flag is now passed as an argument, but provider might have its own check
  const trulyFinal = isFinal || (provider.isResponseComplete ? provider.isResponseComplete(responseElement) : false);

  console.log(CS_LOG_PREFIX, `Captured response (length: ${responseText.length}), isFinal: ${trulyFinal}. Passed isFinal: ${isFinal}`);
  
  if (currentRequestId === null) {
      console.warn(CS_LOG_PREFIX, "captureResponse: currentRequestId is null. Cannot send response to background.");
      return;
  }

  // Call handleProviderResponse, which will then relay to background
  // This centralizes the logic for sending FINAL_RESPONSE_TO_RELAY
  handleProviderResponse(currentRequestId, responseText, trulyFinal);
}

// Function to clear all active response monitoring timers
function clearResponseMonitoringTimers() {
    console.log(CS_LOG_PREFIX, `Clearing ${responseMonitoringTimers.length} response monitoring timers.`);
    responseMonitoringTimers.forEach(timerId => clearTimeout(timerId)); // Works for both setTimeout and setInterval IDs
    responseMonitoringTimers = []; // Reset the array
}

// Define message listener function *before* calling it
// Renamed setupAutomaticMessageSending to setupMessageListeners
function setupMessageListeners() { // Renamed from setupAutomaticMessageSending
  // Listen for commands from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "SEND_CHAT_MESSAGE") {
      const messageContent = message.messageContent; // Use messageContent
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
        messagePreview = `Data type: ${typeof messageContent}, Value: ${String(messageContent).substring(0,50)}`;
      }
      console.log(CS_LOG_PREFIX, "Received command to send message:", messagePreview, "Request ID:", message.requestId, "Last Processed Text:", message.lastProcessedText ? `"${message.lastProcessedText.substring(0,50)}..."` : "null");

      if (!provider) {
        console.error(CS_LOG_PREFIX, "Cannot send message: No provider detected.");
        sendResponse({ success: false, error: "No provider detected" });
        return true;
      }

      // Superseding / duplicate requestId logic (unchanged)
      if (processingMessage && currentRequestId !== null && currentRequestId !== message.requestId) {
        console.warn(CS_LOG_PREFIX, `New message (requestId: ${message.requestId}) received while request ${currentRequestId} was processing. The new message will supersede the old one.`);
        clearResponseMonitoringTimers();
        processingMessage = false;
        currentRequestId = null;
      } else if (processingMessage && currentRequestId === message.requestId) {
        console.warn(CS_LOG_PREFIX, `Received duplicate SEND_CHAT_MESSAGE for already processing requestId: ${message.requestId}. Ignoring duplicate command.`);
        sendResponse({ success: false, error: "Duplicate command for already processing requestId."});
        return true;
      }

      // Attempt to get the input field
      const inputField = document.querySelector(provider.inputSelector);
      let currentUIInputText = null;

      if (inputField) {
        currentUIInputText = inputField.value;
      } else {
        console.error(CS_LOG_PREFIX, "Input field not found via selector:", provider.inputSelector, "Cannot process SEND_CHAT_MESSAGE for requestId:", message.requestId);
        // Reset state if this was meant to be the current request
        if (currentRequestId === message.requestId) { // Check if we were about to set this as current
            processingMessage = false; // Ensure it's reset if it was about to become active
            // currentRequestId is not yet set to message.requestId here if it's a new command
        }
        sendResponse({ success: false, error: "Input field not found by content script." });
        return true;
      }

      // Duplicate Message Scenario Check:
      // 1. We have a record of the last processed text from the background script.
      // 2. The server is trying to send that exact same text again (messageContent === message.lastProcessedText).
      // 3. The UI input field also currently contains that exact same text (currentUIInputText === messageContent).
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
        inputField.value = ''; // Clear the input field
        // Optionally, dispatch 'input' or 'change' events if the website needs them for reactivity
        // inputField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

        chrome.runtime.sendMessage({
          type: "DUPLICATE_MESSAGE_HANDLED",
          requestId: message.requestId,
          originalText: messageContent // The text that was duplicated
        }, response => {
          if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending DUPLICATE_MESSAGE_HANDLED:', chrome.runtime.lastError.message);
          } else {
            console.log(CS_LOG_PREFIX, 'DUPLICATE_MESSAGE_HANDLED sent to background, response:', response);
          }
        });

        // This request is now considered "handled" by the content script (as a duplicate).
        // Reset content script's immediate processing state if this was about to become the active request.
        // Note: currentRequestId might not yet be message.requestId if this is a brand new command.
        // The background script will manage its own processingRequest flag based on DUPLICATE_MESSAGE_HANDLED.
        // For content.js, we ensure we don't proceed to send this.
        // If currentRequestId was already message.requestId (e.g. from a retry/glitch), reset it.
        if (currentRequestId === message.requestId) {
            processingMessage = false;
            currentRequestId = null;
        }
        
        sendResponse({ success: true, message: "Duplicate message scenario handled by clearing input." });
        return true;
      }

      // If not a duplicate, proceed with normal sending logic:
      console.log(CS_LOG_PREFIX, `Not a duplicate scenario for requestId: ${message.requestId}. Proceeding to send.`);
      processingMessage = true;
      currentRequestId = message.requestId;
      console.log(CS_LOG_PREFIX, `Set currentRequestId to ${currentRequestId} for processing.`);

      if (provider && typeof provider.sendChatMessage === 'function') {
        provider.sendChatMessage(messageContent, currentRequestId) // Pass messageContent and the requestId
          .then(success => {
            if (success) {
              console.log(CS_LOG_PREFIX, `Message sending initiated successfully via provider for requestId: ${currentRequestId}.`);
              if (provider.initiateResponseCapture && typeof provider.initiateResponseCapture === 'function') {
                console.log(CS_LOG_PREFIX, `Calling provider.initiateResponseCapture for requestId: ${currentRequestId}`);
                provider.initiateResponseCapture(currentRequestId, handleProviderResponse);
              } else {
                console.error(CS_LOG_PREFIX, `Provider ${provider.name} does not have initiateResponseCapture method. Response will not be processed for requestId ${currentRequestId}.`);
                // If no response capture, this request might hang on the server side.
                // Consider sending an error back to background.js or directly to server.
                 chrome.runtime.sendMessage({
                    type: "FINAL_RESPONSE_TO_RELAY",
                    requestId: currentRequestId,
                    error: `Provider ${provider.name} cannot capture responses. Message sent but no response will be relayed.`,
                    isFinal: true
                });
                processingMessage = false; // As we can't process response
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
        currentRequestId = null; // Ensure reset if it was about to be set
        sendResponse({ success: false, error: "Provider or sendChatMessage method missing." });
      }
      return true; // Indicate async response
    } else if (message.type === "DEBUGGER_RESPONSE") {
      console.log(CS_LOG_PREFIX, "Received DEBUGGER_RESPONSE message object:", JSON.stringify(message)); // Log full received message
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
      // IMPORTANT: The message.requestId IS the application's original requestId,
      // associated by background.js. We should use this directly.
      // The content.js currentRequestId might have been cleared if the provider.sendChatMessage failed,
      // but the debugger stream might still be valid for message.requestId.

      if (!message.requestId && message.requestId !== 0) { // Check if message.requestId is missing or invalid (0 is a valid requestId)
          console.error(CS_LOG_PREFIX, `Received DEBUGGER_RESPONSE without a valid message.requestId. Ignoring. Message:`, message);
          sendResponse({ success: false, error: "DEBUGGER_RESPONSE missing requestId." });
          return true;
      }

      // Pass the raw data, the message's requestId, and isFinal flag to the provider
      // The provider's handleDebuggerData is responsible for calling handleProviderResponse
      console.log(CS_LOG_PREFIX, `Calling provider.handleDebuggerData for requestId: ${message.requestId} with isFinal: ${message.isFinal}`); // Log before call
      provider.handleDebuggerData(message.requestId, message.data, message.isFinal, handleProviderResponse);
      // Acknowledge receipt of the debugger data
      sendResponse({ success: true, message: "Debugger data passed to provider." });
      return true; // Indicate async response (provider will eventually call handleProviderResponse)

    } else if (message.type === "PING_TAB") {
      console.log(CS_LOG_PREFIX, "Received PING_TAB from background script.");
      sendResponse({ success: true, message: "PONG" });
      return true;
    } else if (message.action === "STOP_STREAMING") {
      console.log(CS_LOG_PREFIX, `Received STOP_STREAMING command for requestId: ${message.requestId}`);
      if (provider && typeof provider.stopStreaming === 'function') {
        provider.stopStreaming(message.requestId);
        // The handleProviderResponse might have already cleared currentRequestId if it matched.
        // We ensure processingMessage is false if this was the active request.
        if (currentRequestId === message.requestId) {
            processingMessage = false;
            currentRequestId = null; // Explicitly clear here as well
            clearResponseMonitoringTimers(); // Ensure any DOM timers are also cleared
            console.log(CS_LOG_PREFIX, `STOP_STREAMING: Cleared active currentRequestId ${message.requestId} and processingMessage flag.`);
        }
        sendResponse({ success: true, message: `Streaming stopped for requestId: ${message.requestId}` });
      } else {
        console.error(CS_LOG_PREFIX, "Provider or provider.stopStreaming is not available for STOP_STREAMING command.");
        sendResponse({ success: false, error: "Provider or stopStreaming method missing." });
      }
      return true;
    }

    // Handle other potential message types if needed
    // else if (message.type === '...') { ... }

    // If the message type isn't handled, return false or undefined
    console.log(CS_LOG_PREFIX, "Unhandled message type received:", message.type || message.action);
    // sendResponse({ success: false, error: "Unhandled message type" }); // Optional: send error back
    // return false; // Or let it be undefined
  });
}

// Generic callback function passed to the provider.
// The provider calls this when it has determined the final response or a chunk of it.
function handleProviderResponse(requestId, responseText, isFinal) {
  console.log(CS_LOG_PREFIX, `handleProviderResponse called for requestId: ${requestId}. Data length: ${responseText ? String(responseText).length : 'null'}. isFinal: ${isFinal}. Data (first 100 chars): '${(responseText || "").substring(0,100)}', Type: ${typeof responseText}`);
  
  // The requestId parameter here is the one that the provider determined this response is for.
  // This should be the definitive requestId for this piece of data.
  // We log if content.js's currentRequestId is different, but proceed with the passed 'requestId'.
  if (currentRequestId !== requestId && currentRequestId !== null) { // also check currentRequestId is not null to avoid warning on initial load or after reset
      console.warn(CS_LOG_PREFIX, `handleProviderResponse: content.js currentRequestId (${currentRequestId}) differs from provider's response requestId (${requestId}). Proceeding with provider's requestId for data relay.`);
  }
  // Continue to process with the 'requestId' passed to this function.

  if (chrome.runtime && chrome.runtime.sendMessage) {
      const MAX_RESPONSE_TEXT_LENGTH = 500 * 1024; // 500KB limit for safety
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
    // Reset content script state AFTER sending the final response message,
    // but only if the finalized requestId matches what content.js currently considers its active request.
    if (currentRequestId === requestId) {
      processingMessage = false;
      currentRequestId = null;
      clearResponseMonitoringTimers(); // Clear any timers associated with this request
      console.log(CS_LOG_PREFIX, `Processing finished for active requestId: ${requestId}. State reset in content.js.`);
    } else {
      console.log(CS_LOG_PREFIX, `Processing finished for requestId: ${requestId}. This was not the active content.js requestId (${currentRequestId}), so content.js state not altered by this finalization. However, timers for ${requestId} might need explicit cleanup if any were started by it.`);
      // If specific timers were associated with 'requestId' (not currentRequestId), they should be cleared by the provider or a more granular timer management.
    }
  } else {
    console.log(CS_LOG_PREFIX, `Partial response processed for requestId: ${requestId}. Awaiting more data or final flag.`);
  }
}


// Call initialization functions
// Ensure DOM is ready for provider detection and DOM manipulations
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attemptInitialization);
} else {
    attemptInitialization(); // DOMContentLoaded has already fired
}

function attemptInitialization() {
    console.log(CS_LOG_PREFIX, "Attempting initialization...");
    if (window.attemptedInitialization) {
        console.log(CS_LOG_PREFIX, "Initialization already attempted. Skipping.");
        return;
    }
    window.attemptedInitialization = true;
    initializeContentRelay(); // Initialize provider detection, DOM setup, etc.
    setupMessageListeners();  // Setup listeners for messages from background script
    console.log(CS_LOG_PREFIX, "Initialization attempt complete. Message listeners set up.");
}
