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
// AI Chat Relay - Kimi K2 Provider

class KimiK2Provider {
  constructor() {
    this.name = 'KimiK2Provider';
    this.supportedDomains = ['k2.kimi.ai'];

    // --- START OF CONFIGURABLE PROPERTIES ---
    this.captureMethod = 'dom'; // DOM capture by default
    this.debuggerUrlPattern = '*k2.kimi.ai/api/chat*'; // Placeholder
    this.includeThinkingInMessage = false;
    // --- END OF CONFIGURABLE PROPERTIES ---

    this.inputSelector = 'textarea, div[contenteditable="true"]';
    this.sendButtonSelector = 'button[type="submit"], button.send-btn';
    this.responseSelector = '.message.ai, .chat-message.ai';
    this.thinkingIndicatorSelector = '.typing, .loading';

    this.lastSentMessage = '';
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map();
  }

  async sendChatMessage(text) {
    console.log(`[${this.name}] sendChatMessage called:`, text);
    const inputElement = document.querySelector(this.inputSelector);
    const sendButton = document.querySelector(this.sendButtonSelector);
    if (!inputElement || !sendButton) {
      console.error(`[${this.name}] Missing input (${this.inputSelector}) or send button (${this.sendButtonSelector})`);
      return false;
    }

    this.lastSentMessage = text;

    if (inputElement.tagName.toLowerCase() === 'div' && inputElement.contentEditable === 'true') {
      inputElement.focus();
      inputElement.innerHTML = '';
      inputElement.textContent = text;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      inputElement.value = text;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.focus();
    }
    await new Promise(r => setTimeout(r, 300));

    if (!sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
      sendButton.click();
      return true;
    }

    console.warn(`[${this.name}] Send button disabled.`);
    return false;
  }

  captureResponse(element) {
    if (!element) return { found: false, text: '' };
    let text = element.textContent.trim();
    if (!text || text === this.lastSentMessage) return { found: false, text: '' };
    return { found: true, text };
  }

  initiateResponseCapture(requestId, callback) {
    this.pendingResponseCallbacks.set(requestId, callback);
    if (this.captureMethod === 'dom') {
      console.log(`[${this.name}] DOM capture active for ${requestId}`);
    }
  }

  handleDebuggerData(requestId, rawData, isFinal) {
    const cb = this.pendingResponseCallbacks.get(requestId);
    if (!cb) return;

    const parsed = this.parseDebuggerResponse(rawData);
    if (parsed.text || isFinal) {
      cb(requestId, parsed.text, isFinal);
    }
    if (isFinal) {
      this.pendingResponseCallbacks.delete(requestId);
    }
  }

  parseDebuggerResponse(raw) {
    if (!raw) return { text: '', isFinalResponse: false };
    if (raw.includes('[DONE]')) {
      const clean = raw.replace('[DONE]', '').trim();
      return { text: clean, isFinalResponse: true };
    }
    return { text: raw.trim(), isFinalResponse: false };
  }

  getStreamingApiPatterns() {
    if (this.captureMethod === 'debugger' && this.debuggerUrlPattern) {
      return [{ urlPattern: this.debuggerUrlPattern, requestStage: 'Response' }];
    }
    return [];
  }

  shouldSkipResponseMonitoring() {
    return this.captureMethod === 'debugger';
  }
}

(function() {
  if (window.providerUtils) {
    const providerInstance = new KimiK2Provider();
    window.providerUtils.registerProvider(providerInstance.name, providerInstance.supportedDomains, providerInstance);
  } else {
    console.error('ProviderUtils not found. KimiK2Provider cannot be registered.');
  }
})();

