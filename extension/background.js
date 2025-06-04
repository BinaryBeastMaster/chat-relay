const DEFAULT_SETTINGS = {
    serverHost: 'localhost',
    serverPort: 3003,
    serverProtocol: 'ws'
};

let relaySocket = null;
let reconnectInterval = 5000;
let reconnectTimer = null;
let activeTabId = null;
let serverUrl = '';
let lastRequestId = null;
let processingRequest = false;
let pendingRequests = [];
let lastSuccessfullyProcessedMessageText = null;
const pendingRequestDetails = new Map();
let currentRequestTargetTabId = null;

const supportedDomains = ['gemini.google.com', 'aistudio.google.com', 'chatgpt.com', 'claude.ai'];

const BG_LOG_PREFIX = '[BG DEBUGGER]';
let debuggerAttachedTabs = new Map();


function loadSettingsAndConnect() {
    console.log("BACKGROUND: Loading settings and connecting to relay server");
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
        serverUrl = `${items.serverProtocol}://${items.serverHost}:${items.serverPort}`;
        console.log("BACKGROUND: Using server URL:", serverUrl);
        connectToRelayServer();
    });
}

function connectToRelayServer() {
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
        console.log("BACKGROUND: Relay WS: Already connected.");
        return;
    }

    if (!navigator.onLine) {
        console.warn("BACKGROUND: Network offline. Deferring connection attempt.");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectToRelayServer, reconnectInterval);
        return;
    }

    const healthCheckUrl = serverUrl.replace(/^ws/, 'http') + '/health';
    console.log("BACKGROUND: Performing HTTP pre-check to", healthCheckUrl);

    fetch(healthCheckUrl)
        .then(response => {
            if (!response.ok) {
                console.warn(`BACKGROUND: HTTP pre-check to ${healthCheckUrl} received non-OK status: ${response.status}. Server might be having issues. Deferring WebSocket attempt.`);
                return Promise.reject(new Error(`Server responded with ${response.status}`));
            }
            return response.json();
        })
        .then(healthData => {
            console.log(`BACKGROUND: HTTP pre-check to ${healthCheckUrl} successful. Server status: ${healthData.status}, Active Connections: ${healthData.activeBrowserConnections}. Proceeding with WebSocket connection.`);
            attemptWebSocketConnection();
        })
        .catch(fetchError => {
            console.warn(`BACKGROUND: HTTP pre-check to ${healthCheckUrl} failed: ${fetchError.message}. Server is likely down, unreachable, or health endpoint is misbehaving. Deferring WebSocket attempt.`);
            relaySocket = null;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connectToRelayServer, reconnectInterval);
        });
}

function attemptWebSocketConnection() {
    console.log("BACKGROUND: Relay WS: Attempting to connect to", serverUrl);
    try {
        relaySocket = new WebSocket(serverUrl);

        relaySocket.onopen = () => {
            console.log("BACKGROUND: Relay WS: Connection established with relay server.");
            reconnectInterval = 5000;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
        };

        relaySocket.onmessage = (event) => {
            console.log("BACKGROUND: Relay WS: Message received from relay server:", event.data);
            try {
                const command = JSON.parse(event.data);
                if (command.type === 'SEND_CHAT_MESSAGE') {
                    console.log("BACKGROUND: Received SEND_CHAT_MESSAGE command with requestId:", command.requestId);

                    pendingRequestDetails.set(command.requestId, {
                        messageContent: command.message,
                        settings: command.settings
                    });
                    let messagePreview = "";
                    const messageValue = command.message;
                    if (typeof messageValue === 'string') {
                        messagePreview = `String: "${messageValue.substring(0, 50)}..."`;
                    } else if (messageValue instanceof ArrayBuffer) {
                        messagePreview = `ArrayBuffer data (size: ${messageValue.byteLength} bytes)`;
                    } else if (messageValue instanceof Blob) {
                        messagePreview = `Blob data (size: ${messageValue.size} bytes, type: ${messageValue.type})`;
                    } else if (messageValue && typeof messageValue === 'object' && messageValue !== null) {
                        messagePreview = `Object data (type: ${Object.prototype.toString.call(messageValue)})`;
                    } else {
                        messagePreview = `Data type: ${typeof messageValue}, Value: ${String(messageValue).substring(0, 50)}`;
                    }
                    console.log(`BACKGROUND: Stored details for requestId: ${command.requestId}, message: ${messagePreview}`);

                    pendingRequests.push(command);
                    console.log(`BACKGROUND: Added command with requestId: ${command.requestId} to queue. Queue length: ${pendingRequests.length}`);

                    processNextRequest();
                }
            } catch (error) {
                console.error("BACKGROUND: Relay WS: Error processing message from relay server:", error);
            }
        };

        relaySocket.onerror = (errorEvent) => {
            console.warn("BACKGROUND: Relay WS: WebSocket connection error (event):", errorEvent);
        };

        relaySocket.onclose = (closeEvent) => {
            console.log(`BACKGROUND: Relay WS: Connection closed (event). Code: ${closeEvent.code}, Reason: '${closeEvent.reason || 'N/A'}', Cleanly: ${closeEvent.wasClean}. Will attempt reconnect (via connectToRelayServer) in ${reconnectInterval / 1000}s.`);
            relaySocket = null;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connectToRelayServer, reconnectInterval);
        };
    } catch (instantiationError) {
        console.error("BACKGROUND: Relay WS: Error instantiating WebSocket:", instantiationError);
        relaySocket = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        console.log(`BACKGROUND: Relay WS: Instantiation failed. Will attempt reconnect (via connectToRelayServer) in ${reconnectInterval / 1000}s.`);
        reconnectTimer = setTimeout(connectToRelayServer, reconnectInterval);
    }
}

async function forwardCommandToContentScript(command) {
    try {
        console.log("BACKGROUND: Forwarding command to content script:", command);
        let targetTabIdForCommand = null;

        if (activeTabId) {
            try {
                console.log(`BACKGROUND: Attempting to use stored activeTabId: ${activeTabId}`);
                await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(activeTabId, { type: "PING_TAB" }, response => {
                        if (chrome.runtime.lastError || !response || !response.success) {
                            console.warn(`BACKGROUND: Ping to stored tab ${activeTabId} failed or no ack:`, chrome.runtime.lastError ? chrome.runtime.lastError.message : "No response/success false");
                            activeTabId = null;
                            reject(new Error("Ping failed"));
                        } else {
                            console.log(`BACKGROUND: Ping to stored tab ${activeTabId} successful.`);
                            targetTabIdForCommand = activeTabId;
                            resolve();
                        }
                    });
                });
            } catch (error) {
                console.warn(`BACKGROUND: Error using stored activeTabId ${activeTabId}, will find new tab:`, error);
            }
        }

        if (!targetTabIdForCommand) {
            targetTabIdForCommand = await findAndSendToSuitableTab(command, true);
        }

        if (targetTabIdForCommand) {
            if (processingRequest && command.requestId === lastRequestId) {
                currentRequestTargetTabId = targetTabIdForCommand;
                console.log(`BACKGROUND: Set currentRequestTargetTabId to ${targetTabIdForCommand} for active requestId ${lastRequestId}`);
            }
            const tabInfo = debuggerAttachedTabs.get(targetTabIdForCommand);
            if (tabInfo) {
                tabInfo.lastKnownRequestId = command.requestId;
                console.log(BG_LOG_PREFIX, `Associated requestId ${command.requestId} with tab ${targetTabIdForCommand} for debugger.`);
            } else {
                console.warn(BG_LOG_PREFIX, `Tab ${targetTabIdForCommand} is not being debugged. Cannot associate requestId for debugger.`);
            }

            chrome.tabs.sendMessage(targetTabIdForCommand, command, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(`BACKGROUND: Error sending message to tab ${targetTabIdForCommand}:`, chrome.runtime.lastError.message);
                    if (lastRequestId === command.requestId) {
                        processingRequest = false;
                    }
                } else {
                    console.log(`BACKGROUND: Content script in tab ${targetTabIdForCommand} acknowledged command:`, response);
                }
            });

        } else {
            const errorMsg = "Could not find any suitable tab for command.";
            console.error(`BACKGROUND: ${errorMsg} for requestId: ${command.requestId}.`);

            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE_ERROR",
                    requestId: command.requestId,
                    error: errorMsg
                }));
                console.log(`BACKGROUND: Sent CHAT_RESPONSE_ERROR to server for requestId: ${command.requestId} (no suitable tab).`);
            } else {
                console.error(`BACKGROUND: Relay WS not OPEN, cannot send CHAT_RESPONSE_ERROR for requestId: ${command.requestId} (no suitable tab).`);
            }

            if (lastRequestId === command.requestId) {
                processingRequest = false;
                currentRequestTargetTabId = null;
                console.log(`BACKGROUND: Reset processingRequest and currentRequestTargetTabId for requestId: ${command.requestId} (no suitable tab).`);
            }
            processNextRequest();
        }

    } catch (error) {
        console.error("BACKGROUND: Error in forwardCommandToContentScript for requestId:", command.requestId, error);
        if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
            relaySocket.send(JSON.stringify({
                type: "CHAT_RESPONSE_ERROR",
                requestId: command.requestId,
                error: `Internal error in background script while forwarding command: ${error.message}`
            }));
            console.log(`BACKGROUND: Sent CHAT_RESPONSE_ERROR to server for requestId: ${command.requestId} (exception).`);
        } else {
            console.error(`BACKGROUND: Relay WS not OPEN, cannot send CHAT_RESPONSE_ERROR for requestId: ${command.requestId} (exception).`);
        }

        if (lastRequestId === command.requestId) {
            processingRequest = false;
            currentRequestTargetTabId = null;
            console.log(`BACKGROUND: Reset processingRequest and currentRequestTargetTabId for requestId: ${command.requestId} (exception).`);
        }
    }
}

async function findAndSendToSuitableTab(command, justFinding = false) {
    try {
        console.log("BACKGROUND: Finding suitable tab for command:", command);
        const allTabs = await chrome.tabs.query({});
        const matchingTabs = allTabs.filter(tab => {
            if (!tab.url) return false;
            return supportedDomains.some(domain => tab.url.includes(domain));
        });

        console.log(`BACKGROUND: Found ${matchingTabs.length} tabs matching supported domains`);

        if (matchingTabs.length > 0) {
            const activeMatchingTabs = matchingTabs.filter(tab => tab.active);
            const targetTab = activeMatchingTabs.length > 0 ? activeMatchingTabs[0] : matchingTabs[0];
            console.log(`BACKGROUND: Selected tab ${targetTab.id} (${targetTab.url})`);
            activeTabId = targetTab.id;

            if (justFinding) {
                return targetTab.id;
            }

            console.warn("BACKGROUND: findAndSendToSuitableTab called with justFinding=false. Sending is now handled by caller.");
            return targetTab.id;

        } else {
            console.error("BACKGROUND: Could not find any tabs matching supported domains.");
            return null;
        }
    } catch (error) {
        console.error("BACKGROUND: Error finding suitable tab:", error);
        return null;
    }
}

function processNextRequest() {
    console.log("BACKGROUND: Processing next request, queue length:", pendingRequests.length);
    if (processingRequest && pendingRequests.length > 0) {
        console.log("BACKGROUND: Still processing a request, deferring processNextRequest call.");
        return;
    }

    if (pendingRequests.length > 0) {
        const nextCommand = pendingRequests.shift();
        console.log("BACKGROUND: Processing next command from queue:", nextCommand);

        if (!pendingRequestDetails.has(nextCommand.requestId) && nextCommand.message !== undefined) {
            pendingRequestDetails.set(nextCommand.requestId, { messageContent: nextCommand.message });
            let preview = typeof nextCommand.message === 'string' ? `"${nextCommand.message.substring(0, 30)}..."` : `Type: ${typeof nextCommand.message}`;
            console.log(`BACKGROUND: Stored details (messageContent) for queued requestId: ${nextCommand.requestId} (Message: ${preview}) while processing queue.`);
        }

        processingRequest = true;
        lastRequestId = nextCommand.requestId;

        setTimeout(() => {
            forwardCommandToContentScript({
                action: "SEND_CHAT_MESSAGE",
                requestId: nextCommand.requestId,
                messageContent: nextCommand.message,
                settings: nextCommand.settings,
                lastProcessedText: lastSuccessfullyProcessedMessageText
            });
        }, 500);
    } else {
        console.log("BACKGROUND: No pending requests to process.");
    }
}

function isUrlSupportedByProvider(url, providerName) {
    if (providerName === "AIStudioProvider") {
        return url.includes("aistudio.google.com");
    }
    if (providerName === "GeminiProvider") {
        return url.includes("gemini.google.com");
    }
    if (providerName === "ChatGptProvider") {
        return url.includes("chatgpt.com");
    }
    if (providerName === "ClaudeProvider") {
        return url.includes("claude.ai");
    }
    console.warn(BG_LOG_PREFIX, `isUrlSupportedByProvider: Unknown providerName '${providerName}'`);
    return false;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const isSupportedDomain = supportedDomains.some(domain => tab.url.includes(domain));
        if (isSupportedDomain) {
            console.log(`BACKGROUND: A supported tab ${tabId} (${tab.url}) was updated. Checking if it should be the active tab.`);
            if (tab.active || !activeTabId) {
                const currentProvider = providerUtils.getProviderForUrl(tab.url);
                if (currentProvider) {
                    activeTabId = tabId;
                    console.log(`BACKGROUND: Set ${tabId} (${tab.url}) as the active tab.`);
                }
            }
        }
    }

    const attachmentDetails = debuggerAttachedTabs.get(tabId);
    if (attachmentDetails && attachmentDetails.isAttached && changeInfo.url && tab && tab.url) {
        console.log(BG_LOG_PREFIX, `Tab ${tabId} updated. Old URL: ${changeInfo.url}, New URL: ${tab.url}. Checking debugger status.`);

        const providerStillValidForNewUrl = isUrlSupportedByProvider(tab.url, attachmentDetails.providerName);

        if (providerStillValidForNewUrl) {
            console.log(BG_LOG_PREFIX, `Tab ${tabId} URL changed to ${tab.url}. Provider ${attachmentDetails.providerName} still valid. Re-initiating debugger attachment.`);
            const oldProviderName = attachmentDetails.providerName;
            const oldPatterns = attachmentDetails.patterns;

            await detachDebugger(tabId);

            try {
                const updatedTabInfo = await chrome.tabs.get(tabId);
                if (updatedTabInfo) {
                    console.log(BG_LOG_PREFIX, `Proactively re-attaching debugger to ${tabId} (${updatedTabInfo.url}) with provider ${oldProviderName}.`);
                    await attachDebuggerAndEnableFetch(tabId, oldProviderName, oldPatterns);

                    if (processingRequest && lastRequestId !== null && tabId === currentRequestTargetTabId) {
                        const interruptedRequestDetails = pendingRequestDetails.get(lastRequestId);
                        if (interruptedRequestDetails) {
                            console.warn(BG_LOG_PREFIX, `Tab ${tabId} update (URL: ${tab.url}) may have interrupted processing for requestId: ${lastRequestId}. Attempting to resend after a delay.`);

                            setTimeout(() => {
                                if (processingRequest && lastRequestId !== null && tabId === currentRequestTargetTabId && pendingRequestDetails.has(lastRequestId)) {
                                    console.log(BG_LOG_PREFIX, `Re-forwarding command for interrupted requestId: ${lastRequestId} to tab ${tabId}`);
                                    forwardCommandToContentScript({
                                        action: "SEND_CHAT_MESSAGE",
                                        requestId: lastRequestId,
                                        messageContent: interruptedRequestDetails.messageContent,
                                        settings: interruptedRequestDetails.settings,
                                        lastProcessedText: lastSuccessfullyProcessedMessageText
                                    });
                                } else {
                                    console.log(BG_LOG_PREFIX, `Resend for ${lastRequestId} aborted; state changed before resend timeout. Current processing: ${processingRequest}, current lastReqId: ${lastRequestId}, current targetTab: ${currentRequestTargetTabId}, details still pending: ${pendingRequestDetails.has(lastRequestId)}`);
                                }
                            }, 2000);
                        } else {
                            console.warn(BG_LOG_PREFIX, `Tab ${tabId} update occurred while processing requestId: ${lastRequestId}, but no details found in pendingRequestDetails to resend. The request might have been cleared by another process.`);

                            if (processingRequest && lastRequestId !== null && tabId === currentRequestTargetTabId) {
                                console.error(BG_LOG_PREFIX, `Critical state: Tab update for ${tabId} (target of ${lastRequestId}), but details missing. Forcing reset of processing state for ${lastRequestId}.`);
                                if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                                    relaySocket.send(JSON.stringify({
                                        type: "CHAT_RESPONSE_ERROR",
                                        requestId: lastRequestId,
                                        error: `Request ${lastRequestId} processing was interrupted by tab update and its details were lost. Cannot resend.`
                                    }));
                                }
                                processingRequest = false;
                                currentRequestTargetTabId = null;
                                pendingRequestDetails.delete(lastRequestId);
                                const tabInfoForReset = debuggerAttachedTabs.get(tabId);
                                if (tabInfoForReset && tabInfoForReset.lastKnownRequestId === lastRequestId) {
                                    tabInfoForReset.lastKnownRequestId = null;
                                }
                                processNextRequest();
                            }
                        }
                    }

                    if (processingRequest && lastRequestId !== null && tabId === currentRequestTargetTabId) {
                        const interruptedRequestDetails = pendingRequestDetails.get(lastRequestId);
                        if (interruptedRequestDetails) {
                            console.warn(BG_LOG_PREFIX, `Tab ${tabId} update (URL: ${tab.url}) may have interrupted processing for requestId: ${lastRequestId}. Attempting to resend after a delay.`);

                            setTimeout(() => {
                                if (processingRequest && lastRequestId !== null && tabId === currentRequestTargetTabId && pendingRequestDetails.has(lastRequestId)) {
                                    console.log(BG_LOG_PREFIX, `Re-forwarding command for interrupted requestId: ${lastRequestId} to tab ${tabId}`);
                                    forwardCommandToContentScript({
                                        action: "SEND_CHAT_MESSAGE",
                                        requestId: lastRequestId,
                                        messageContent: interruptedRequestDetails.messageContent,
                                        settings: interruptedRequestDetails.settings,
                                        lastProcessedText: lastSuccessfullyProcessedMessageText
                                    });
                                } else {
                                    console.log(BG_LOG_PREFIX, `Resend for ${lastRequestId} aborted; state changed before resend timeout. Current processing: ${processingRequest}, current lastReqId: ${lastRequestId}, current targetTab: ${currentRequestTargetTabId}, details still pending: ${pendingRequestDetails.has(lastRequestId)}`);
                                }
                            }, 2000);
                        } else {
                            console.warn(BG_LOG_PREFIX, `Tab ${tabId} update occurred while processing requestId: ${lastRequestId}, but no details found in pendingRequestDetails to resend. The request might have been cleared by another process.`);
                            if (processingRequest && lastRequestId !== null && tabId === currentRequestTargetTabId) {
                                console.error(BG_LOG_PREFIX, `Critical state: Tab update for ${tabId} (target of ${lastRequestId}), but details missing. Forcing reset of processing state for ${lastRequestId}.`);
                                if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                                    relaySocket.send(JSON.stringify({
                                        type: "CHAT_RESPONSE_ERROR",
                                        requestId: lastRequestId,
                                        error: `Request ${lastRequestId} processing was interrupted by tab update and its details were lost. Cannot resend.`
                                    }));
                                }
                                processingRequest = false;
                                currentRequestTargetTabId = null;
                                pendingRequestDetails.delete(lastRequestId);
                                const tabInfoForReset = debuggerAttachedTabs.get(tabId);
                                if (tabInfoForReset && tabInfoForReset.lastKnownRequestId === lastRequestId) {
                                    tabInfoForReset.lastKnownRequestId = null;
                                }
                                processNextRequest();
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn(BG_LOG_PREFIX, `Error getting tab info for ${tabId} during re-attachment attempt:`, error.message);
            }

        } else {
            console.log(BG_LOG_PREFIX, `Tab ${tabId} URL changed to ${tab.url}. Provider ${attachmentDetails.providerName} no longer valid or URL not supported by provider. Detaching debugger.`);
            await detachDebugger(tabId);
        }
    } else if (attachmentDetails && attachmentDetails.isAttached && changeInfo.status === 'loading' && tab && tab.url && !changeInfo.url) {
        const newUrl = tab.url;
        console.log(BG_LOG_PREFIX, `Tab ${tabId} is loading new URL: ${newUrl}. Checking debugger status.`);
        const providerStillValidForNewUrl = isUrlSupportedByProvider(newUrl, attachmentDetails.providerName);
        if (!providerStillValidForNewUrl) {
            console.log(BG_LOG_PREFIX, `Tab ${tabId} loading new URL ${newUrl}. Provider ${attachmentDetails.providerName} may no longer be valid. Detaching.`);
            await detachDebugger(tabId);
        }
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("BACKGROUND: Received message:", message.type || message.action, "from tabId:", sender.tab ? sender.tab.id : 'popup/unknown');

    if (sender.tab && sender.tab.id) {
        activeTabId = sender.tab.id;
        console.log(`BACKGROUND: Updated activeTabId to ${activeTabId} from sender`);
    }

    if (message.type === "SET_DEBUGGER_TARGETS") {
        if (sender.tab && sender.tab.id) {
            const tabId = sender.tab.id;
            console.log(BG_LOG_PREFIX, `SET_DEBUGGER_TARGETS for tab ${tabId}, provider: ${message.providerName}, patterns:`, message.patterns);
            attachDebuggerAndEnableFetch(tabId, message.providerName, message.patterns);
            sendResponse({ status: "Debugger attachment initiated" });
        } else {
            console.error(BG_LOG_PREFIX, "SET_DEBUGGER_TARGETS message received without valid sender.tab.id");
            sendResponse({ status: "Error: Missing tabId" });
        }
        return true;
    }
    else if (message.type === "CHAT_RELAY_READY") {
        console.log(`BACKGROUND: Content script ready in ${message.chatInterface} on tab ${sender.tab ? sender.tab.id : 'unknown'}`);
        if (sender.tab && sender.tab.id) activeTabId = sender.tab.id;
        sendResponse({ success: true });
        return true;
    } else if (message.action === "RESPONSE_CAPTURED") {
        console.log(`BACKGROUND: Received captured response (OLD DOM METHOD) from content script on tab ${sender.tab ? sender.tab.id : 'unknown'} Request ID: ${message.requestId}`);

        if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
            console.log("BACKGROUND: Forwarding (OLD DOM) response to relay server:", message.response);
            relaySocket.send(JSON.stringify({
                type: "CHAT_RESPONSE",
                requestId: message.requestId,
                response: message.response,
                isFinal: true
            }));
            sendResponse({ success: true });

            if (lastRequestId === message.requestId) {
                processingRequest = false;
                console.log("BACKGROUND: Reset processingRequest after (OLD DOM) RESPONSE_CAPTURED.");
                processNextRequest();
            }

        } else {
            console.error("BACKGROUND: Relay WS not connected, cannot forward (OLD DOM) response");
            sendResponse({ success: false, error: "Relay WebSocket not connected" });
            if (lastRequestId === message.requestId) {
                processingRequest = false;
            }
        }
        return true;
    } else if (message.action === "GET_CONNECTION_STATUS") {
        const isConnected = relaySocket && relaySocket.readyState === WebSocket.OPEN;
        sendResponse({ connected: isConnected });
        return true;
    } else if (message.type === "CHAT_RESPONSE_FROM_DOM") {
        console.log(`BACKGROUND: Received CHAT_RESPONSE_FROM_DOM from tab ${sender.tab ? sender.tab.id : 'unknown'} for requestId ${message.requestId}`);
        const tabId = sender.tab ? sender.tab.id : null;
        const tabInfo = tabId ? debuggerAttachedTabs.get(tabId) : null;

        if (tabInfo && tabInfo.lastKnownRequestId === message.requestId && processingRequest) {
            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE_CHUNK",
                    requestId: message.requestId,
                    chunk: message.text,
                    isFinal: message.isFinal !== undefined ? message.isFinal : true
                }));
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE_STREAM_ENDED",
                    requestId: message.requestId
                }));
                console.log(`BACKGROUND: Sent CHAT_RESPONSE_CHUNK (from DOM) and _STREAM_ENDED for app requestId: ${message.requestId}`);
                sendResponse({ success: true, message: "DOM Response forwarded to relay." });
            } else {
                console.error(`BACKGROUND: Relay WS not connected, cannot send DOM-captured response for requestId: ${message.requestId}`);
                sendResponse({ success: false, error: "Relay WebSocket not connected." });
            }
            processingRequest = false;
            if (tabInfo) tabInfo.lastKnownRequestId = null;
            console.log(`BACKGROUND: Reset processingRequest. Cleared lastKnownRequestId for tab ${tabId} after DOM response.`);
            processNextRequest();
        } else {
            console.warn(`BACKGROUND: Mismatched requestId or not processing for CHAT_RESPONSE_FROM_DOM. Current lastKnownRequestId: ${tabInfo ? tabInfo.lastKnownRequestId : 'N/A'}, processingRequest: ${processingRequest}, msg RequestId: ${message.requestId}`);
            sendResponse({ success: false, error: "Mismatched requestId or not processing." });
        }
        return true;
    } else if (message.type === "CHAT_RESPONSE_FROM_DOM_FAILED") {
        console.error(`BACKGROUND: Received CHAT_RESPONSE_FROM_DOM_FAILED from tab ${sender.tab ? sender.tab.id : 'unknown'} for requestId ${message.requestId}: ${message.error}`);
        const tabId = sender.tab ? sender.tab.id : null;
        const tabInfo = tabId ? debuggerAttachedTabs.get(tabId) : null;

        if (tabInfo && tabInfo.lastKnownRequestId === message.requestId && processingRequest) {
            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE_ERROR",
                    requestId: message.requestId,
                    error: `Failed to capture response from DOM on tab ${tabId}: ${message.error}`
                }));
            }
            sendResponse({ success: true, message: "DOM failure noted and error sent to relay." });
            processingRequest = false;
            if (tabInfo) tabInfo.lastKnownRequestId = null;
            console.log(`BACKGROUND: Reset processingRequest. Cleared lastKnownRequestId for tab ${tabId} after DOM failure.`);
            processNextRequest();
        } else {
            console.warn(`BACKGROUND: Mismatched requestId or not processing for CHAT_RESPONSE_FROM_DOM_FAILED. Current lastKnownRequestId: ${tabInfo ? tabInfo.lastKnownRequestId : 'N/A'}, processingRequest: ${processingRequest}, msg RequestId: ${message.requestId}`);
            sendResponse({ success: false, error: "Mismatched requestId or not processing for DOM failure." });
        }
        return true;
    } else if (message.type === "FINAL_RESPONSE_TO_RELAY") {
        console.log(BG_LOG_PREFIX, `[REQ-${message.requestId}] RECEIVED FINAL_RESPONSE_TO_RELAY. FromTab: ${sender.tab ? sender.tab.id : 'N/A'}. HasError: ${!!message.error}. TextLength: ${message.text ? String(message.text).length : 'N/A'}. IsFinal: ${message.isFinal}. FullMsg:`, JSON.stringify(message).substring(0, 500));
        const tabId = sender.tab ? sender.tab.id : null;
        const tabInfo = tabId ? debuggerAttachedTabs.get(tabId) : null;

        const details = pendingRequestDetails.get(message.requestId);
        if (details) {
            if (typeof details.messageContent === 'string') {
                lastSuccessfullyProcessedMessageText = details.messageContent;
                console.log(`BACKGROUND: Updated lastSuccessfullyProcessedMessageText to: "${lastSuccessfullyProcessedMessageText.substring(0, 50)}..." for completed requestId ${message.requestId}`);
            } else {
                console.log(`BACKGROUND: RequestId ${message.requestId} (messageContent type: ${typeof details.messageContent}) completed. lastSuccessfullyProcessedMessageText not updated with non-string content.`);
            }
            pendingRequestDetails.delete(message.requestId);
        } else {
            console.warn(`BACKGROUND: Received FINAL_RESPONSE_TO_RELAY for unknown requestId ${message.requestId} (not in pendingRequestDetails). Cannot update lastSuccessfullyProcessedMessageText accurately.`);
        }

        if (processingRequest && lastRequestId === message.requestId) {
            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                if (message.error) {
                    console.error(BG_LOG_PREFIX, `Content script reported an error for requestId ${message.requestId}: ${message.error}`);
                    try {
                        relaySocket.send(JSON.stringify({
                            type: "CHAT_RESPONSE_ERROR",
                            requestId: message.requestId,
                            error: message.error
                        }));
                        console.log(BG_LOG_PREFIX, `Sent CHAT_RESPONSE_ERROR to server for requestId ${message.requestId} due to content script error.`);
                        sendResponse({ success: true, message: "Error reported by content script sent to relay." });
                    } catch (e) {
                        console.error(BG_LOG_PREFIX, `Error sending CHAT_RESPONSE_ERROR to relay for requestId ${message.requestId}:`, e);
                        sendResponse({ success: false, error: `Error sending CHAT_RESPONSE_ERROR to relay: ${e.message}` });
                    }
                } else {
                    try {
                        let responseText = message.text || "";
                        
                        // Decode text if it was encoded by content script
                        if (message.encoded) {
                            responseText = decodeURIComponent(responseText);
                        }
                        
                        console.log(BG_LOG_PREFIX, `Attempting to send FINAL CHAT_RESPONSE_CHUNK for requestId ${message.requestId}. Data length: ${responseText.length}`);
                        relaySocket.send(JSON.stringify({
                            type: "CHAT_RESPONSE_CHUNK",
                            requestId: message.requestId,
                            chunk: responseText,
                            isFinal: true
                        }));
                        console.log(BG_LOG_PREFIX, `Attempting to send CHAT_RESPONSE_STREAM_ENDED for requestId ${message.requestId}`);
                        relaySocket.send(JSON.stringify({
                            type: "CHAT_RESPONSE_STREAM_ENDED",
                            requestId: message.requestId
                        }));
                        console.log(BG_LOG_PREFIX, `Successfully sent FINAL CHAT_RESPONSE_CHUNK and _STREAM_ENDED for app requestId: ${message.requestId} to relaySocket.`);
                        sendResponse({ success: true, message: "Final response sent to relay." });
                    } catch (e) {
                        console.error(BG_LOG_PREFIX, `Error during relaySocket.send() for FINAL response (requestId ${message.requestId}):`, e);
                        sendResponse({ success: false, error: `Error sending final response to relay: ${e.message}` });
                    }
                }
            } else {
                console.error(BG_LOG_PREFIX, `Relay WS not OPEN (state: ${relaySocket ? relaySocket.readyState : 'null'}), cannot send final response/error for app requestId: ${message.requestId}`);
                sendResponse({ success: false, error: "Relay WebSocket not connected." });
            }

            console.log(BG_LOG_PREFIX, `Processing complete for command with app requestId: ${message.requestId} on tab ${tabId}`);
            processingRequest = false;
            currentRequestTargetTabId = null;
            if (tabInfo) tabInfo.lastKnownRequestId = null;
            console.log(BG_LOG_PREFIX, `Reset processingRequest. Cleared lastKnownRequestId for tab ${tabId}.`);
            processNextRequest();
        } else {
            console.warn(`BACKGROUND: Received FINAL_RESPONSE_TO_RELAY for requestId ${message.requestId}, but not currently processing it (current: ${lastRequestId}, processing: ${processingRequest}). Ignoring.`);
            sendResponse({ success: false, error: "Request ID mismatch or not processing." });
        }
        return true;
    } else if (message.type === "DUPLICATE_MESSAGE_HANDLED") {
        console.log(`BACKGROUND: Content script handled requestId ${message.requestId} as a duplicate of text: "${message.originalText ? message.originalText.substring(0, 50) : 'N/A'}..."`);

        lastSuccessfullyProcessedMessageText = message.originalText;
        pendingRequestDetails.delete(message.requestId);
        console.log(`BACKGROUND: Updated lastSuccessfullyProcessedMessageText (due to duplicate) to: "${lastSuccessfullyProcessedMessageText ? lastSuccessfullyProcessedMessageText.substring(0, 50) : 'N/A'}..."`);

        if (processingRequest && lastRequestId === message.requestId) {
            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE",
                    requestId: message.requestId,
                    response: `[ChatRelay Extension] Request to send duplicate message ("${message.originalText ? message.originalText.substring(0, 100) : 'N/A'}") was detected and cleared from input. No message sent to AI.`,
                    isFinal: true
                }));
                console.log(`BACKGROUND: Sent CHAT_RESPONSE (for duplicate) to server for requestId: ${message.requestId}.`);
            } else {
                console.error(`BACKGROUND: Relay WS not OPEN, cannot send CHAT_RESPONSE (for duplicate) for requestId: ${message.requestId}.`);
            }

            processingRequest = false;
            currentRequestTargetTabId = null;
            const tabInfo = sender.tab ? debuggerAttachedTabs.get(sender.tab.id) : null;
            if (tabInfo && tabInfo.lastKnownRequestId === message.requestId) {
                tabInfo.lastKnownRequestId = null;
            }

            console.log(`BACKGROUND: Reset processingRequest after DUPLICATE_MESSAGE_HANDLED for requestId: ${message.requestId}.`);
            processNextRequest();
        } else {
            console.warn(`BACKGROUND: Received DUPLICATE_MESSAGE_HANDLED for requestId ${message.requestId}, but not currently processing it or ID mismatch. Current lastRequestId: ${lastRequestId}, processing: ${processingRequest}. Still updated LSPMT.`);
            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE",
                    requestId: message.requestId,
                    response: `[ChatRelay Extension] An older/superseded request (ID: ${message.requestId}, Text: "${message.originalText ? message.originalText.substring(0, 100) : 'N/A'}") was handled as a duplicate.`,
                    isFinal: true
                }));
            }
        }
        sendResponse({ success: true, message: "Duplicate handling acknowledged by background." });
        return true;
    } else if (message.type === "USER_STOP_REQUEST") {
        const requestIdToStop = message.requestId;
        console.log(`BACKGROUND: Received USER_STOP_REQUEST for requestId: ${requestIdToStop}`);
        let responseSent = false;

        if (processingRequest && lastRequestId === requestIdToStop) {
            console.log(`BACKGROUND: Initiating stop for currently processing request: ${lastRequestId}. Content script will send FINAL_RESPONSE_TO_RELAY.`);
            if (activeTabId) {
                chrome.tabs.sendMessage(activeTabId, {
                    action: "STOP_STREAMING",
                    requestId: lastRequestId
                }, response => {
                    if (chrome.runtime.lastError) {
                        console.error(`BACKGROUND: Error sending STOP_STREAMING to tab ${activeTabId} for requestId ${lastRequestId}:`, chrome.runtime.lastError.message);
                    } else {
                        console.log(`BACKGROUND: Sent STOP_STREAMING to tab ${activeTabId} for requestId ${lastRequestId}. Content script ack:`, response);
                    }
                });
            } else {
                console.warn(`BACKGROUND: Cannot send STOP_STREAMING for currently processing requestId ${lastRequestId}, activeTabId is null. This request might not be properly finalized by the provider.`);
                if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                    relaySocket.send(JSON.stringify({
                        type: "CHAT_RESPONSE_ERROR",
                        requestId: lastRequestId,
                        error: "Request cancelled by user (no active tab to signal provider)."
                    }));
                }
                processingRequest = false;
                currentRequestTargetTabId = null;
                pendingRequestDetails.delete(lastRequestId);
                console.log(`BACKGROUND: Forcefully reset processingRequest for ${lastRequestId} due to USER_STOP_REQUEST with no active tab.`);
                processNextRequest();
            }

            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                relaySocket.send(JSON.stringify({
                    type: "CHAT_RESPONSE_ERROR",
                    requestId: lastRequestId,
                    error: "Request cancelled by user."
                }));
                console.log(`BACKGROUND: Sent CHAT_RESPONSE_ERROR (user cancelled) to server for currently processing requestId: ${lastRequestId}.`);
            }

            sendResponse({ success: true, message: `Stop initiated for currently processing request ${lastRequestId}. Waiting for finalization from content script.` });
            responseSent = true;

        } else {
            const initialQueueLength = pendingRequests.length;
            pendingRequests = pendingRequests.filter(req => req.requestId !== requestIdToStop);
            if (pendingRequests.length < initialQueueLength) {
                console.log(`BACKGROUND: Removed requestId ${requestIdToStop} from pendingRequests queue.`);
                pendingRequestDetails.delete(requestIdToStop);

                if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                    relaySocket.send(JSON.stringify({
                        type: "CHAT_RESPONSE_ERROR",
                        requestId: requestIdToStop,
                        error: `Request ${requestIdToStop} cancelled by user while in queue.`
                    }));
                    console.log(`BACKGROUND: Sent CHAT_RESPONSE_ERROR (user cancelled in queue) to server for requestId: ${requestIdToStop}.`);
                }
                if (!responseSent) sendResponse({ success: true, message: `Request ${requestIdToStop} removed from queue.` });
                responseSent = true;
            }
        }

        if (!responseSent) {
            console.warn(`BACKGROUND: USER_STOP_REQUEST for ${requestIdToStop}, but it was not actively processing nor found in the pending queue. Current active: ${lastRequestId}, processing: ${processingRequest}`);
            sendResponse({ success: false, error: "Request not found processing or in queue." });
        }
        return true;
    }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        let needsReconnect = false;
        if (changes.serverHost || changes.serverPort || changes.serverProtocol) {
            needsReconnect = true;
        }

        if (needsReconnect) {
            console.log("BACKGROUND: Server settings changed, reconnecting...");
            if (relaySocket) {
                relaySocket.close();
            } else {
                loadSettingsAndConnect();
            }
        }
    }
});

loadSettingsAndConnect();

const providerUtils = {
    _providers: {},
    registerProvider: function (name, domains, instance) {
        this._providers[name] = { instance, domains };
    },
    getProviderForUrl: function (url) {
        for (const name in this._providers) {
            if (this._providers[name].domains.some(domain => url.includes(domain))) {
                return this._providers[name].instance;
            }
        }
        return null;
    },
    _initializeSimulatedProviders: function () {
        this.registerProvider("AIStudioProvider", ["aistudio.google.com"], { name: "AIStudioProvider" });
        this.registerProvider("GeminiProvider", ["gemini.google.com"], { name: "GeminiProvider" });
        this.registerProvider("GeminiProvider", ["chatgpt.com"], { name: "ChatGPTProvider" });
        this.registerProvider("GeminiProvider", ["claude.ai"], { name: "ClaudeProvider" });

    }
};
providerUtils._initializeSimulatedProviders();

console.log("BACKGROUND: AI Chat Relay: Background Service Worker started.");


async function attachDebuggerAndEnableFetch(tabId, providerName, patterns) {
    if (!tabId || !patterns || patterns.length === 0) {
        console.error(BG_LOG_PREFIX, `attachDebuggerAndEnableFetch: Invalid parameters for tab ${tabId}. Patterns:`, patterns);
        return;
    }
    const debuggee = { tabId: tabId };
    const requiredVersion = "1.3";

    try {
        const existingAttachment = debuggerAttachedTabs.get(tabId);
        if (existingAttachment && existingAttachment.isAttached) {
            console.log(BG_LOG_PREFIX, `Already attached to tab ${tabId}. Ensuring Fetch is enabled with latest patterns.`);
        } else {
            console.log(BG_LOG_PREFIX, `Attempting to attach debugger to tab ${tabId}`);
            await new Promise((resolve, reject) => {
                chrome.debugger.attach(debuggee, requiredVersion, () => {
                    if (chrome.runtime.lastError) {
                        console.error(BG_LOG_PREFIX, `Error attaching debugger to tab ${tabId}:`, chrome.runtime.lastError.message);
                        debuggerAttachedTabs.delete(tabId);
                        return reject(chrome.runtime.lastError);
                    }
                    console.log(BG_LOG_PREFIX, `Successfully attached debugger to tab ${tabId}`);
                    debuggerAttachedTabs.set(tabId, {
                        providerName: providerName,
                        patterns: patterns,
                        isFetchEnabled: false,
                        isAttached: true,
                        lastKnownRequestId: null
                    });
                    resolve();
                });
            });
        }

        const currentTabDataForPatterns = debuggerAttachedTabs.get(tabId);
        if (currentTabDataForPatterns) {
            currentTabDataForPatterns.patterns = patterns;
            currentTabDataForPatterns.providerName = providerName;
        }

        console.log(BG_LOG_PREFIX, `Enabling Fetch domain for tab ${tabId} with patterns:`, patterns);
        await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(debuggee, "Fetch.enable", { patterns: patterns }, () => {
                if (chrome.runtime.lastError) {
                    console.error(BG_LOG_PREFIX, `Error enabling Fetch for tab ${tabId}:`, chrome.runtime.lastError.message);
                    return reject(chrome.runtime.lastError);
                }
                console.log(BG_LOG_PREFIX, `Successfully enabled Fetch for tab ${tabId}`);
                const currentTabData = debuggerAttachedTabs.get(tabId);
                if (currentTabData) {
                    currentTabData.isFetchEnabled = true;
                }
                resolve();
            });
        });
    } catch (error) {
        console.error(BG_LOG_PREFIX, `Error in attachDebuggerAndEnableFetch for tab ${tabId}:`, error);
        const currentTabData = debuggerAttachedTabs.get(tabId);
        if (currentTabData && !currentTabData.isAttached) {
            debuggerAttachedTabs.delete(tabId);
        }
    }
}

async function detachDebugger(tabId) {
    if (!tabId) return;
    const attachmentDetails = debuggerAttachedTabs.get(tabId);
    if (attachmentDetails && attachmentDetails.isAttached) {
        console.log(BG_LOG_PREFIX, `Attempting to detach debugger from tab ${tabId}`);
        try {
            await new Promise((resolve, reject) => {
                chrome.debugger.detach({ tabId: tabId }, () => {
                    if (chrome.runtime.lastError) {
                        console.error(BG_LOG_PREFIX, `Error detaching debugger from tab ${tabId}:`, chrome.runtime.lastError.message);
                    } else {
                        console.log(BG_LOG_PREFIX, `Successfully detached debugger from tab ${tabId}`);
                    }
                    debuggerAttachedTabs.delete(tabId);
                    resolve();
                });
            });
        } catch (error) {
            console.error(BG_LOG_PREFIX, `Exception during detach for tab ${tabId}:`, error);
            debuggerAttachedTabs.delete(tabId);
        }
    } else {
        debuggerAttachedTabs.delete(tabId);
    }
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log(BG_LOG_PREFIX, `Tab ${tabId} removed. Detaching debugger if attached.`);
    detachDebugger(tabId);
});

chrome.runtime.onSuspend.addListener(() => {
    console.log(BG_LOG_PREFIX, "Extension suspending. Detaching all debuggers.");
    for (const tabId of debuggerAttachedTabs.keys()) {
        detachDebugger(tabId);
    }
});

chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
        console.log(BG_LOG_PREFIX, `Debugger detached from tab ${source.tabId} (e.g. DevTools closed) due to: ${reason}. Cleaning up.`);
        debuggerAttachedTabs.delete(source.tabId);
    }
});

chrome.debugger.onEvent.addListener((debuggeeId, message, params) => {
    if (!debuggeeId.tabId) return;
    const tabId = debuggeeId.tabId;
    const tabInfo = debuggerAttachedTabs.get(tabId);

    function parseAiStudioResponse(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            let combinedText = "";
            if (Array.isArray(parsed)) {
                for (const topLevelEntry of parsed) {
                    if (topLevelEntry && topLevelEntry[0] && topLevelEntry[0][2] && Array.isArray(topLevelEntry[0][2])) {
                        for (const candidateBlock of topLevelEntry[0][2]) {
                            if (candidateBlock && candidateBlock[0] && candidateBlock[0][0] && candidateBlock[0][0][0] && Array.isArray(candidateBlock[0][0][0][0])) {
                                for (const innerMostArray of candidateBlock[0][0][0][0]) {
                                    if (Array.isArray(innerMostArray) && innerMostArray.length > 1 && typeof innerMostArray[1] === 'string') {
                                        const textSegment = innerMostArray[1];
                                        if (!textSegment.toLowerCase().includes("thinking process") &&
                                            !textSegment.toLowerCase().includes("thought process") &&
                                            !textSegment.startsWith("1.") &&
                                            !textSegment.startsWith("2.") &&
                                            !textSegment.startsWith("3.") &&
                                            !textSegment.startsWith("4.") &&
                                            !textSegment.startsWith("5.") &&
                                            !textSegment.startsWith("6.") &&
                                            textSegment.trim() !== "**") {
                                            combinedText += textSegment;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let cleanedMessage = combinedText.replace(/\*\*/g, "").replace(/\\n/g, "\n").replace(/\n\s*\n/g, '\n').trim();

            if (cleanedMessage) {
                console.log(BG_LOG_PREFIX, "Parsed AI Studio response to (first 100 chars):", cleanedMessage.substring(0, 100));
                return cleanedMessage;
            } else {
                console.warn(BG_LOG_PREFIX, "Parsing AI Studio response yielded empty text. Original (first 200 chars):", jsonString.substring(0, 200));
            }
        } catch (e) {
            console.error(BG_LOG_PREFIX, "Error parsing AI Studio response JSON:", e, "Original string (first 200 chars):", jsonString.substring(0, 200));
        }
        console.warn(BG_LOG_PREFIX, "Failed to extract clean text from AI Studio response, returning raw data.");
        return jsonString;
    }

    if (message === "Fetch.requestPaused") {
        console.log(BG_LOG_PREFIX, `Fetch.requestPaused for tab ${tabId}, URL: ${params.request.url}, RequestId (debugger): ${params.requestId}, Stage: ${params.responseErrorReason || params.requestStage}`);

        if (!tabInfo || !tabInfo.isFetchEnabled) {
            console.log(BG_LOG_PREFIX, `Tab ${tabId} not actively monitored or Fetch not enabled. Continuing request.`);
            chrome.debugger.sendCommand(debuggeeId, "Fetch.continueRequest", { requestId: params.requestId });
            return;
        }

        if (params.responseStatusCode && params.responseStatusCode >= 200 && params.responseStatusCode < 300) {
            if (params.requestStage !== "Response") {
                console.warn(BG_LOG_PREFIX, `Proceeding to getResponseBody for tab ${tabId}, debugger requestId ${params.requestId}, even though requestStage is '${params.requestStage}' (expected 'Response'). Status: ${params.responseStatusCode}`);
            }

            chrome.debugger.sendCommand(debuggeeId, "Fetch.getResponseBody", { requestId: params.requestId }, (responseBodyData) => {
                let currentOperationRequestId = null;
                try {
                    if (chrome.runtime.lastError) {
                        console.error(BG_LOG_PREFIX, `Error calling Fetch.getResponseBody for tab ${tabId}, debugger requestId ${params.requestId}:`, chrome.runtime.lastError.message);
                        return;
                    }
                    if (!responseBodyData) {
                        console.error(BG_LOG_PREFIX, `Fetch.getResponseBody returned null or undefined for tab ${tabId}, debugger requestId ${params.requestId}.`);
                        return;
                    }
                    console.log(BG_LOG_PREFIX, `Raw responseBodyData for debugger requestId ${params.requestId} (first 200 chars):`, JSON.stringify(responseBodyData).substring(0, 200) + "...");

                    const rawBodyText = responseBodyData.base64Encoded ? new TextDecoder('utf-8').decode(Uint8Array.from(atob(responseBodyData.body), c => c.charCodeAt(0))) : responseBodyData.body;

                    if (rawBodyText === undefined || rawBodyText === null) {
                        console.error(BG_LOG_PREFIX, `Extracted rawBodyText is undefined or null for debugger requestId ${params.requestId}.`);
                        return;
                    }

                    let tempRequestId = tabInfo ? tabInfo.lastKnownRequestId : null;

                    if (processingRequest && lastRequestId !== null) {
                        if (tempRequestId !== null && tempRequestId === lastRequestId) {
                            currentOperationRequestId = tempRequestId;
                            console.log(BG_LOG_PREFIX, `Using tabInfo.lastKnownRequestId: ${currentOperationRequestId} for debugger event on tab ${tabId} (debugger requestId ${params.requestId})`);
                        } else {
                            currentOperationRequestId = lastRequestId;
                            console.warn(BG_LOG_PREFIX, `Using global lastRequestId: ${currentOperationRequestId} for debugger event on tab ${tabId} (debugger requestId ${params.requestId}). TabInfo had: ${tempRequestId}.`);
                        }
                    } else if (tempRequestId !== null) {
                        currentOperationRequestId = tempRequestId;
                        console.warn(BG_LOG_PREFIX, `Not in global processingRequest, but using tabInfo.lastKnownRequestId: ${currentOperationRequestId} for debugger event on tab ${tabId} (debugger requestId ${params.requestId}). This might be unexpected.`);
                    } else {
                        currentOperationRequestId = null;
                    }

                    if (currentOperationRequestId === null || currentOperationRequestId === undefined) {
                        console.warn(BG_LOG_PREFIX, `Could not determine currentOperationRequestId for debugger event on tab ${tabId} (debugger requestId ${params.requestId}). Global lastRequestId: ${lastRequestId}, processingRequest: ${processingRequest}, tabInfo.lastKnownRequestId: ${tabInfo ? tabInfo.lastKnownRequestId : 'N/A'}. Ignoring body.`);
                        return;
                    }

                    if (rawBodyText === "") {
                        console.warn(BG_LOG_PREFIX, `Received empty rawBodyText for app requestId ${currentOperationRequestId} (debugger requestId ${params.requestId}). Not processing further for this event, waiting for potential subsequent data.`);
                        return;
                    }
                    console.log(BG_LOG_PREFIX, `Raw bodyText for tab ${tabId}, debugger requestId ${params.requestId} (first 100 chars):`, rawBodyText.substring(0, 100));

                    const dataToSend = rawBodyText;

                    console.log(BG_LOG_PREFIX, `Data to send for app requestId ${currentOperationRequestId} (first 100 chars): '${dataToSend ? dataToSend.substring(0, 100) : "[EMPTY_DATA]"}'`);

                    if (currentOperationRequestId !== null && currentOperationRequestId !== undefined && pendingRequestDetails.has(currentOperationRequestId)) {
                        if (tabId) {
                            const messageToSend = {
                                type: "DEBUGGER_RESPONSE",
                                requestId: currentOperationRequestId,
                                data: dataToSend,
                                isFinal: true
                            };
                            console.log(BG_LOG_PREFIX, `Attempting to send DEBUGGER_RESPONSE to tab ${tabId} for app requestId ${currentOperationRequestId}. Message object:`, JSON.stringify(messageToSend));
                            chrome.tabs.sendMessage(tabId, messageToSend, response => {
                                if (chrome.runtime.lastError || !response || !response.success) {
                                    const errorMessage = chrome.runtime.lastError ? chrome.runtime.lastError.message : (response && response.error ? response.error : "No response or success false from content script");
                                    console.error(BG_LOG_PREFIX, `Error sending/acking DEBUGGER_RESPONSE to tab ${tabId} (app requestId ${currentOperationRequestId}): ${errorMessage}`);

                                    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
                                        relaySocket.send(JSON.stringify({
                                            type: "CHAT_RESPONSE_ERROR",
                                            requestId: currentOperationRequestId,
                                            error: `Failed to send/ack DEBUGGER_RESPONSE to content script for requestId ${currentOperationRequestId}: ${errorMessage}`
                                        }));
                                    }
                                    if (processingRequest && lastRequestId === currentOperationRequestId) {
                                        processingRequest = false;
                                        pendingRequestDetails.delete(currentOperationRequestId);
                                        const tabInfoForReset = debuggerAttachedTabs.get(tabId);
                                        if (tabInfoForReset && tabInfoForReset.lastKnownRequestId === currentOperationRequestId) {
                                            tabInfoForReset.lastKnownRequestId = null;
                                        }
                                        console.log(BG_LOG_PREFIX, `Reset processingRequest due to DEBUGGER_RESPONSE send/ack failure for requestId ${currentOperationRequestId}.`);
                                        processNextRequest();
                                    }
                                } else {
                                    console.log(BG_LOG_PREFIX, `Successfully sent DEBUGGER_RESPONSE to tab ${tabId} (app requestId ${currentOperationRequestId}), content script ack:`, response);
                                    console.log(BG_LOG_PREFIX, `Debugger response acknowledged by content script for app requestId ${currentOperationRequestId}. Waiting for FINAL_RESPONSE_TO_RELAY from provider.`);
                                }
                            });
                        }
                    } else {
                        console.warn(BG_LOG_PREFIX, `Skipping sending DEBUGGER_RESPONSE for app requestId ${currentOperationRequestId} (debugger requestId ${params.requestId}) because it's no longer in pendingRequestDetails or ID is null/undefined. Tab: ${tabId}.`);
                    }
                } finally {
                    console.log(BG_LOG_PREFIX, `[FINALLY] Continuing debugger request ${params.requestId}.`);
                    chrome.debugger.sendCommand(debuggeeId, "Fetch.continueRequest", { requestId: params.requestId }, () => {
                        if (chrome.runtime.lastError) {
                            console.error(BG_LOG_PREFIX, `Error continuing request ${params.requestId} for tab ${tabId} in finally:`, chrome.runtime.lastError.message);
                        }
                    });
                }
            });
        } else {
            console.log(BG_LOG_PREFIX, `Fetch.requestPaused for tab ${tabId} (debugger requestId ${params.requestId}). Not a capturable success response. Status: ${params.responseStatusCode}, ErrorReason: ${params.responseErrorReason}, Stage: ${params.requestStage}. Continuing request.`);
            chrome.debugger.sendCommand(debuggeeId, "Fetch.continueRequest", { requestId: params.requestId });
        }
    }
});
