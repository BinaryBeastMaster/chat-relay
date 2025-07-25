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
// AI Chat Relay - Provider Index

// Map of provider IDs to provider instances
const providers = {
  'gemini': window.geminiProvider,
  'aistudio': window.aiStudioProvider,
  'chatgpt': window.chatgptProvider,
  'claude': window.claudeProvider,
  'kimi_k2': window.kimiK2Provider
};

// Get a provider by ID
function getProvider(id) {
  return providers[id] || null;
}

// Get a provider based on the current URL
function detectProvider(url) {
  if (url.includes('gemini.google.com')) {
    return providers.gemini;
  } else if (url.includes('aistudio.google.com')) {
    return providers.aistudio;
  } else if (url.includes('chatgpt.com')) {
    return providers.chatgpt;
  } else if (url.includes('claude.ai')) {
    return providers.claude;
  } else if (url.includes('k2.kimi.ai')) {
    return providers.kimi_k2;
  }
  
  // Default to aistudio if we can't detect
  return providers.aistudio;
}

// Get all supported domains
function getSupportedDomains() {
  return Object.values(providers).flatMap(provider => provider.supportedDomains);
}

// Make functions available globally
window.providerUtils = {
  getProvider,
  detectProvider,
  getSupportedDomains
};