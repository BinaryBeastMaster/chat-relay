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
import bodyParser from 'body-parser';
import { execSync } from 'child_process'; // Import for executing commands
import cors from 'cors';
import express, { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
// Interfaces
interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}
interface WebSocketMessage {
  type: string;
  requestId?: number;
  message?: string;     // For messages sent from server to extension
  response?: string;    // For CHAT_RESPONSE from extension (older DOM method)
  chunk?: string;       // For CHAT_RESPONSE_CHUNK from extension (debugger method)
  isFinal?: boolean;    // Flag for CHAT_RESPONSE_CHUNK
  error?: string;       // For CHAT_RESPONSE_ERROR from extension
  settings?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
  };
}

// Queuing/Dropping System State
let activeExtensionProcessingId: number | null = null;
// newRequestBehavior will be initialized after loadServerConfig()
let newRequestBehavior: 'queue' | 'drop';
interface QueuedRequest {
  requestId: number;
  req: Request; // Express Request object
  res: Response; // Express Response object
  userMessage: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}
let requestQueue: QueuedRequest[] = [];

// Global variables
let activeConnections: WebSocket[] = [];
const pendingRequests = new Map<number, PendingRequest>();
let requestCounter = 0;

// In-memory store for admin messages
interface ModelSettings {
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

interface ChatRequestData {
  fromClient: string;
  toExtension: WebSocketMessage; // Assuming WebSocketMessage is defined elsewhere
  modelSettings: ModelSettings;
}

interface ChatResponseData {
  fromExtension: string;
  toClient: any; // This could be more specific if the OpenAI response structure is defined
  status: string;
}

interface ChatErrorData {
  toClientError: any; // This could be more specific if the error JSON structure is defined
  status: string;
}

type AdminLogDataType = ChatRequestData | ChatResponseData | ChatErrorData | any; // Fallback to any for other types

interface AdminLogEntry {
  timestamp: string;
  type:
  | 'CHAT_REQUEST_RECEIVED'
  | 'CHAT_RESPONSE_SENT'
  | 'CHAT_ERROR_RESPONSE_SENT'
  | 'CHAT_REQUEST_QUEUED'
  | 'CHAT_REQUEST_DROPPED'
  | 'CHAT_REQUEST_DEQUEUED'
  | 'CHAT_REQUEST_PROCESSING'
  | 'CHAT_REQUEST_ERROR' // For pre-processing errors like no extension
  | 'SETTING_UPDATE' // Existing type, ensure it's included
  | string; // Fallback for other/future types
  requestId: string;
  data: AdminLogDataType;
}
const MAX_ADMIN_HISTORY_LENGTH = 1000;
let adminMessageHistory: AdminLogEntry[] = [];
const serverStartTime = Date.now(); // Store server start time

// Configuration file path
const CONFIG_FILE_PATH = path.join(__dirname, 'server-config.json');
const RESTART_TRIGGER_FILE_PATH = path.join(__dirname, '.triggerrestart'); // For explicitly triggering nodemon

interface ServerConfig {
  port?: number;
  requestTimeoutMs?: number;
  lastRestartRequestTimestamp?: number; // New field
  newRequestBehavior?: 'queue' | 'drop';
  autoKillPort?: boolean; // New setting for auto-killing port
}

// Function to read configuration
function loadServerConfig(): ServerConfig {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const configFile = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      return JSON.parse(configFile) as ServerConfig;
    }
  } catch (error) {
    console.error('Error reading server-config.json, using defaults/env vars:', error);
  }
  return {};
}

// Function to write configuration
function saveServerConfig(config: ServerConfig): void {
  try {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log('Server configuration saved to server-config.json');
  } catch (error) {
    console.error('Error writing server-config.json:', error);
  }
}

// Load initial config
const initialConfig = loadServerConfig();

// Initialize newRequestBehavior from config, defaulting to 'queue'
newRequestBehavior = initialConfig.newRequestBehavior && (initialConfig.newRequestBehavior === 'queue' || initialConfig.newRequestBehavior === 'drop')
  ? initialConfig.newRequestBehavior
  : 'queue';
let autoKillPort = initialConfig.autoKillPort === undefined ? false : initialConfig.autoKillPort; // Initialize autoKillPort

const PORT = initialConfig.port || parseInt(process.env.PORT || '3003', 10);
let currentRequestTimeoutMs = initialConfig.requestTimeoutMs || parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);
// Create Express app
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' })); // Increased payload size limit
// Admin UI: Serve static files
// Correct path considering TypeScript's outDir. __dirname will be 'dist' at runtime.
const adminUIDirectory = path.join(__dirname, '../src/admin-ui');
app.use('/admin-static', express.static(adminUIDirectory));
// Admin UI: Route for the main admin page
app.get('/admin', (req: Request, res: Response) => {
  res.sendFile(path.join(adminUIDirectory, 'admin.html'));
});
// Create HTTP server
const server = http.createServer(app);
// Create WebSocket server for browser extension communication
const wss = new WebSocketServer({ server });
// Handle WebSocket connections from browser extensions
wss.on('connection', (ws: WebSocket) => {
  console.log('Browser extension connected');
  activeConnections.push(ws);
  // Handle messages from browser extension
  ws.on('message', (message: string) => {
    try {
      const data: WebSocketMessage = JSON.parse(message.toString());
      let requestIdToProcess: number | undefined = undefined;
      let responseDataToUse: string | undefined = undefined;
      let isErrorMessage = false;

      console.log(`SERVER: WebSocket message received from extension: type=${data.type}, requestId=${data.requestId}`);

      if (data.type === 'CHAT_RESPONSE') {
        requestIdToProcess = data.requestId;
        responseDataToUse = data.response;
        console.log(`SERVER: Processing CHAT_RESPONSE for requestId: ${data.requestId}`);
      } else if (data.type === 'CHAT_RESPONSE_CHUNK' && data.isFinal === true) {
        requestIdToProcess = data.requestId;
        responseDataToUse = data.chunk;
        console.log(`SERVER: Processing final CHAT_RESPONSE_CHUNK for requestId: ${data.requestId}`);
      } else if (data.type === 'CHAT_RESPONSE_ERROR') {
        requestIdToProcess = data.requestId;
        responseDataToUse = data.error || "Unknown error from extension";
        isErrorMessage = true;
        console.log(`SERVER: Processing CHAT_RESPONSE_ERROR for requestId: ${data.requestId}`);
      } else if (data.type === 'CHAT_RESPONSE_STREAM_ENDED') {
        // This message type currently doesn't carry the final data itself in background.js,
        // the CHAT_RESPONSE_CHUNK with isFinal=true does.
        // So, we just log it. The promise should be resolved by the final CHUNK.
        console.log(`SERVER: Received CHAT_RESPONSE_STREAM_ENDED for requestId: ${data.requestId}. No action taken as final data comes in CHUNK.`);
        return;
      } else {
        console.log(`SERVER: Received unhandled WebSocket message type: ${data.type} for requestId: ${data.requestId}`);
        return;
      }

      if (requestIdToProcess !== undefined) {
        const pendingRequest = pendingRequests.get(requestIdToProcess);
        if (pendingRequest) {
          if (isErrorMessage) {
            console.error(`SERVER: Rejecting request ${requestIdToProcess} with error: ${responseDataToUse}`);
            pendingRequest.reject(new Error(responseDataToUse || "Error from extension"));
          } else {
            console.log(`SERVER: Resolving request ${requestIdToProcess} with data (first 100 chars): ${(responseDataToUse || "").substring(0, 100)}`);
            pendingRequest.resolve(responseDataToUse);
          }
          pendingRequests.delete(requestIdToProcess);
          console.log(`SERVER: Request ${requestIdToProcess} ${isErrorMessage ? 'rejected' : 'resolved'} and removed from pending.`);
        } else {
          console.warn(`SERVER: Received response for unknown or timed-out requestId: ${requestIdToProcess}. No pending request found.`);
        }
      } else {
        // This case should ideally not be reached if the above 'if/else if' for types is exhaustive for messages carrying a requestId.
        console.warn(`SERVER: Received WebSocket message but could not determine requestId to process. Type: ${data.type}, Full Data:`, data);
      }
    } catch (error) {
      console.error('SERVER: Error processing WebSocket message:', error, 'Raw message:', message.toString());
    }
  });
  // Handle disconnection
  ws.on('close', () => {
    console.log('Browser extension disconnected');
    activeConnections = activeConnections.filter(conn => conn !== ws);
  });
});
// Function to log admin messages to in-memory store
async function logAdminMessage(
  type: AdminLogEntry['type'], // Use the more specific type from AdminLogEntry
  requestId: string | number,
  data: AdminLogDataType      // Use the specific union type for data
): Promise<void> {
  const timestamp = new Date().toISOString();

  // For debugging, let's log what's being passed to logAdminMessage
  // console.log(`LOGGING [${type}] ReqID [${requestId}]:`, JSON.stringify(data, null, 2));

  const logEntry: AdminLogEntry = {
    timestamp,
    type,
    requestId: String(requestId),
    data,
  };

  adminMessageHistory.unshift(logEntry);

  if (adminMessageHistory.length > MAX_ADMIN_HISTORY_LENGTH) {
    adminMessageHistory = adminMessageHistory.slice(0, MAX_ADMIN_HISTORY_LENGTH);
  }
}

// Define processRequest
async function processRequest(queuedItem: QueuedRequest): Promise<void> {
  const { requestId, req, res, userMessage, model, temperature, max_tokens } = queuedItem;
  activeExtensionProcessingId = requestId;

  logAdminMessage('CHAT_REQUEST_PROCESSING', requestId, { status: 'Sending to extension', activeExtensionProcessingId })
    .catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_PROCESSING):", err));
  console.log(`SERVER: Processing request ${requestId}. ActiveExtensionProcessingId: ${activeExtensionProcessingId}`);

  try {
    if (activeConnections.length === 0) {
      console.error(`SERVER: No active extension connection for request ${requestId} during processing.`);
      logAdminMessage('CHAT_REQUEST_ERROR', requestId, {
        reason: "No extension connected during processing attempt",
        activeExtensionProcessingId
      }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_ERROR):", err));
      if (!res.headersSent) {
        res.status(503).json({
          error: {
            message: "No browser extension connected when attempting to process request.",
            type: "server_error",
            code: "no_extension_during_processing"
          }
        });
      }
      return; // Exit early, finally block will call finishProcessingRequest
    }

    const responsePromise = new Promise<string>((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          console.log(`SERVER: Request ${requestId} timed out after ${currentRequestTimeoutMs}ms during active processing. Rejecting promise.`);
          reject(new Error('Request timed out during active processing'));
        }
      }, currentRequestTimeoutMs);
    });

    const extension = activeConnections[0];
    const messageToExtension: WebSocketMessage = {
      type: 'SEND_CHAT_MESSAGE',
      requestId,
      message: userMessage,
      settings: { model, temperature, max_tokens }
    };

    extension.send(JSON.stringify(messageToExtension));
    console.log(`SERVER: Request ${requestId} sent to browser extension via processRequest.`);

    const responseData = await responsePromise;

    const formattedResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "relay-model",
      choices: [{ index: 0, message: { role: "assistant", content: responseData }, finish_reason: "stop" }],
      usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 }
    };

    logAdminMessage('CHAT_RESPONSE_SENT', requestId, {
      fromExtension: responseData,
      toClient: formattedResponse,
      status: "Success (processed)"
    }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_RESPONSE_SENT):", err));
    console.log(`SERVER: Request ${requestId} - Sending formatted response to client from processRequest.`);

    if (!res.headersSent) {
      res.json(formattedResponse);
    }

  } catch (error: any) {
    console.error(`SERVER: Error in processRequest for ${requestId}:`, error);
    const errorResponseJson = {
      message: error.message || "Unknown error during request processing.",
      type: "server_error",
      code: error.message === 'Request timed out during active processing' ? "timeout_during_processing" : "processing_error",
      requestId
    };
    logAdminMessage('CHAT_ERROR_RESPONSE_SENT', requestId, {
      toClientError: errorResponseJson,
      status: `Error in processRequest: ${error.message}`
    }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_ERROR_RESPONSE_SENT):", err));

    if (!res.headersSent) {
      res.status(500).json({ error: errorResponseJson });
    }
  } finally {
    finishProcessingRequest(requestId);
  }
}

function finishProcessingRequest(completedRequestId: number): void {
  activeExtensionProcessingId = null;
  pendingRequests.delete(completedRequestId);
  console.log(`SERVER: Processing finished for requestId: ${completedRequestId}. Extension is now free.`);

  if (newRequestBehavior === 'queue' && requestQueue.length > 0) {
    const nextRequest = requestQueue.shift();
    if (nextRequest) {
      console.log(`SERVER: Dequeuing request ${nextRequest.requestId}. Queue length: ${requestQueue.length}`);
      logAdminMessage('CHAT_REQUEST_DEQUEUED', nextRequest.requestId, {
        queueLength: requestQueue.length,
        dequeuedRequestId: nextRequest.requestId
      }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_DEQUEUED):", err));

      processRequest(nextRequest).catch((error: Error) => {
        console.error(`SERVER: Error processing dequeued request ${nextRequest.requestId}:`, error);
        if (!nextRequest.res.headersSent) {
          nextRequest.res.status(500).json({
            error: {
              message: `Failed to process dequeued request: ${error.message || 'Unknown error'}`,
              type: "server_error",
              code: "dequeued_request_processing_failed",
              requestId: nextRequest.requestId
            }
          });
        }
      });
    }
  }
}

// Create API router
const apiRouter: Router = express.Router();
// OpenAI-compatible chat completions endpoint
apiRouter.post('/chat/completions', async (req: Request, res: Response): Promise<void> => {
  const requestId = requestCounter++;
  const { messages, model, temperature, max_tokens } = req.body;
  const userMessage = messages[messages.length - 1].content;

  // Log initial receipt and intended action
  let initialActionLog = 'DirectProcessing';
  if (activeExtensionProcessingId !== null) {
    initialActionLog = newRequestBehavior === 'queue' ? 'AttemptQueue' : 'AttemptDrop';
  }
  logAdminMessage('CHAT_REQUEST_RECEIVED', requestId, {
    fromClient: userMessage,
    modelSettings: { model, temperature, max_tokens },
    initialAction: initialActionLog, // Use the determined log value
    currentActiveExtensionProcessingId: activeExtensionProcessingId,
    newRequestBehaviorSetting: newRequestBehavior
  }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_RECEIVED):", err));
  console.log(`SERVER: Request ${requestId} received. Initial Action: ${initialActionLog}. Active ID: ${activeExtensionProcessingId}, Behavior: ${newRequestBehavior}`);

  if (activeConnections.length === 0) {
    logAdminMessage('CHAT_REQUEST_ERROR', requestId, {
      reason: "No extension connected at time of request",
      clientMessage: userMessage,
      details: "Response 503 sent to client."
    }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_ERROR):", err));
    console.log(`SERVER: Request ${requestId} - No browser extension connected. Responding 503.`);
    if (!res.headersSent) {
      res.status(503).json({
        error: {
          message: "No browser extension connected. Please open the chat interface and ensure the extension is active.",
          type: "server_error",
          code: "no_extension_connected"
        }
      });
    }
    return;
  }

  const queuedItem: QueuedRequest = {
    requestId,
    req,
    res,
    userMessage,
    model,
    temperature,
    max_tokens
  };

  if (activeExtensionProcessingId !== null) { // Extension is busy
    if (newRequestBehavior === 'drop') {
      logAdminMessage('CHAT_REQUEST_DROPPED', requestId, {
        reason: "Extension busy",
        droppedForRequestId: activeExtensionProcessingId,
        clientMessage: userMessage,
        details: "Response 429 sent to client."
      }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_DROPPED):", err));
      console.log(`SERVER: Request ${requestId} dropped as extension is busy with ${activeExtensionProcessingId}.`);
      if (!res.headersSent) {
        res.status(429).json({
          error: {
            message: "Too Many Requests: Extension is currently busy. Please try again later.",
            type: "client_error",
            code: "extension_busy_request_dropped"
          }
        });
      }
      return;
    }

    if (newRequestBehavior === 'queue') {
      requestQueue.push(queuedItem);
      logAdminMessage('CHAT_REQUEST_QUEUED', requestId, {
        queuePosition: requestQueue.length,
        queuedForRequestId: activeExtensionProcessingId,
        clientMessage: userMessage,
        queueLength: requestQueue.length
      }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_REQUEST_QUEUED):", err));
      console.log(`SERVER: Request ${requestId} queued. Position: ${requestQueue.length}. Extension busy with: ${activeExtensionProcessingId}`);
      // Do NOT send a response yet, the 'res' object is stored in the queue.
      return;
    }
  }

  // If extension is free (activeExtensionProcessingId is null)
  // processRequest will handle its own errors and responses including calling res.json() or res.status().json()
  processRequest(queuedItem).catch(error => {
    // This catch is a safety net if processRequest itself throws an unhandled error *before* it can send a response.
    console.error(`SERVER: Unhandled error from processRequest for ${requestId} in /chat/completions:`, error);
    logAdminMessage('CHAT_ERROR_RESPONSE_SENT', requestId, {
      toClientError: { message: (error as Error).message, type: "server_error", code: "unhandled_processing_catch" },
      status: `Error: ${(error as Error).message}`
    }).catch(err => console.error("ADMIN_LOG_ERROR (CHAT_ERROR_RESPONSE_SENT):", err));
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: `Internal server error during request processing: ${(error as Error).message || 'Unknown error'}`,
          type: "server_error",
          code: "unhandled_processing_error_in_handler",
          requestId: requestId
        }
      });
    }
  });
});
// Models endpoint
apiRouter.get('/models', (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      object: "list",
      data: [
        {
          id: "gemini-pro",
          object: "model",
          created: 1677610602,
          owned_by: "relay"
        },
        {
          id: "claude-3",
          object: "model",
          created: 1677610602,
          owned_by: "relay"
        }
      ]
    });
  } catch (error) {
    next(error);
  }
});

// Endpoint to retrieve message history for Admin UI
apiRouter.get('/admin/message-history', (req: Request, res: Response): void => { // No longer async
  try {
    // Return the latest 100 entries (or fewer if less than 100 exist)
    const historyToReturn = adminMessageHistory.slice(0, 100);
    res.json(historyToReturn); // Objects are already parsed
  } catch (error) {
    console.error('Error fetching message history from in-memory store:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: (error instanceof Error ? error.message : String(error)) || 'Failed to retrieve message history',
          type: 'server_error', // Changed from redis_error
          code: 'history_retrieval_failed'
        }
      });
    }
  }
});

// Endpoint to provide server configuration and status
apiRouter.get('/admin/server-info', (req: Request, res: Response): void => {
  try {
    const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
    const serverInfo = {
      port: PORT,
      requestTimeoutMs: currentRequestTimeoutMs, // Report the current mutable value
      newRequestBehavior: newRequestBehavior, // Add the current behavior
      autoKillPort: autoKillPort, // Add the current autoKillPort setting
      pingIntervalMs: null, // Placeholder - No explicit ping interval defined for client pings
      connectedExtensionsCount: activeConnections.length,
      uptimeSeconds: uptimeSeconds,
    };
    res.json(serverInfo);
  } catch (error) {
    console.error('Error fetching server info:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: (error instanceof Error ? error.message : String(error)) || 'Failed to retrieve server info',
          type: 'server_error',
          code: 'server_info_failed'
        }
      });
    }
  }
});

// Endpoint to restart the server
apiRouter.post('/admin/restart-server', (req: Request, res: Response): void => {
  console.log('ADMIN: Received request to restart server.');
  // Removed premature res.json() call that was here.

  // Log absolute paths for debugging
  const absoluteConfigPath = path.resolve(CONFIG_FILE_PATH);
  const absoluteTriggerPath = path.resolve(RESTART_TRIGGER_FILE_PATH);
  console.log(`ADMIN: Config file path (absolute): ${absoluteConfigPath}`);
  console.log(`ADMIN: Trigger file path (absolute): ${absoluteTriggerPath}`);

  try {
    // 1. Update and save server-config.json
    const configToSave = loadServerConfig();
    configToSave.lastRestartRequestTimestamp = Date.now();
    saveServerConfig(configToSave); // This function already has its own try/catch and logs
    console.log('ADMIN: Attempted to update server-config.json.');

    // 2. Explicitly touch/create the .triggerrestart file.
    try {
      fs.writeFileSync(RESTART_TRIGGER_FILE_PATH, Date.now().toString(), 'utf-8');
      console.log(`ADMIN: Successfully wrote to restart trigger file: ${absoluteTriggerPath}`);
    } catch (triggerFileError) {
      console.error(`ADMIN: FAILED to write restart trigger file at ${absoluteTriggerPath}:`, triggerFileError);
    }
  } catch (outerError) {
    // This catch is for errors in loadServerConfig or if saveServerConfig itself throws unexpectedly
    console.error('ADMIN: Error in outer try block during restart sequence (e.g., loading config):', outerError);
  }

  // 3. Send response to client
  res.status(200).json({ message: 'Server restart initiated. Nodemon should pick up file changes.' });

  // 4. Exit the process after a longer delay.
  setTimeout(() => {
    console.log('ADMIN: Exiting process for nodemon to restart.');
    process.exit(0);
  }, 1500); // Increased delay to 1.5 seconds
});

// The more comprehensive update-settings endpoint below handles both port and requestTimeoutMs.
apiRouter.post('/admin/update-settings', (req: Request, res: Response): void => {
  const { requestTimeoutMs, port, newRequestBehavior: newBehaviorValue, autoKillPort: newAutoKillPortValue } = req.body;
  let configChanged = false;
  let messages: string[] = [];

  const currentConfig = loadServerConfig(); // Load current disk config to preserve other settings

  if (requestTimeoutMs !== undefined) {
    const newTimeout = parseInt(String(requestTimeoutMs), 10);
    if (!isNaN(newTimeout) && newTimeout > 0) {
      currentRequestTimeoutMs = newTimeout; // Update in-memory value immediately
      currentConfig.requestTimeoutMs = newTimeout; // Update config for saving
      configChanged = true;
      messages.push(`Request timeout updated in memory to ${currentRequestTimeoutMs}ms. This change is effective immediately.`);
      logAdminMessage('SETTING_UPDATE', 'SERVER_CONFIG', { setting: 'requestTimeoutMs', value: currentRequestTimeoutMs })
        .catch(err => console.error("ADMIN_LOG_ERROR (SETTING_UPDATE):", err));
    } else {
      res.status(400).json({ error: 'Invalid requestTimeoutMs value. Must be a positive number.' });
      return;
    }
  }

  if (port !== undefined) {
    const newPort = parseInt(String(port), 10);
    if (!isNaN(newPort) && newPort > 0 && newPort <= 65535) {
      currentConfig.port = newPort; // Update config for saving
      configChanged = true;
      messages.push(`Server port configured to ${newPort}. This change will take effect after server restart.`);
      logAdminMessage('SETTING_UPDATE', 'SERVER_CONFIG', { setting: 'port', value: newPort, requiresRestart: true })
        .catch(err => console.error("ADMIN_LOG_ERROR (SETTING_UPDATE):", err));
    } else {
      res.status(400).json({ error: 'Invalid port value. Must be a positive number between 1 and 65535.' });
      return;
    }
  }

  if (newBehaviorValue !== undefined) {
    if (newBehaviorValue === 'queue' || newBehaviorValue === 'drop') {
      newRequestBehavior = newBehaviorValue; // Update in-memory value immediately
      currentConfig.newRequestBehavior = newBehaviorValue; // Update config for saving
      configChanged = true;
      messages.push(`New request behavior updated to '${newRequestBehavior}'. This change is effective immediately.`);
      logAdminMessage('SETTING_UPDATE', 'SERVER_CONFIG', { setting: 'newRequestBehavior', value: newRequestBehavior })
        .catch(err => console.error("ADMIN_LOG_ERROR (SETTING_UPDATE newRequestBehavior):", err));
    } else {
      res.status(400).json({ error: "Invalid newRequestBehavior value. Must be 'queue' or 'drop'." });
      return;
    }
  }

  if (newAutoKillPortValue !== undefined) {
    if (typeof newAutoKillPortValue === 'boolean') {
      autoKillPort = newAutoKillPortValue; // Update in-memory value immediately
      currentConfig.autoKillPort = newAutoKillPortValue; // Update config for saving
      configChanged = true;
      messages.push(`Auto-kill port setting updated to '${autoKillPort}'. This change is effective on next server startup if port conflict occurs.`);
      logAdminMessage('SETTING_UPDATE', 'SERVER_CONFIG', { setting: 'autoKillPort', value: autoKillPort, requiresRestartToSeeEffect: true })
        .catch(err => console.error("ADMIN_LOG_ERROR (SETTING_UPDATE autoKillPort):", err));
    } else {
      res.status(400).json({ error: "Invalid autoKillPort value. Must be a boolean." });
      return;
    }
  }

  if (configChanged) {
    saveServerConfig(currentConfig);
    res.json({ message: messages.join(' ') });
  } else {
    res.status(400).json({ error: 'No valid settings provided or no changes made.' });
  }
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', activeBrowserConnections: activeConnections.length });
});

// Mount the API router
app.use('/v1', apiRouter);

// Function to handle port conflict before starting the server
function handlePortConflict(portToFree: number, killProcess: boolean): void {
  if (!killProcess) {
    console.log(`Auto-kill for port ${portToFree} is disabled. Will not attempt to free port.`);
    return;
  }

  console.log(`Checking if port ${portToFree} is in use...`);
  try {
    // Command to find process using the port (Windows specific)
    const command = `netstat -ano -p TCP | findstr ":${portToFree}.*LISTENING"`;
    const output = execSync(command, { encoding: 'utf-8' });

    if (output) {
      console.log(`Port ${portToFree} is in use. Output:\n${output}`);
      // Extract PID - Example: TCP    0.0.0.0:3003           0.0.0.0:0              LISTENING       12345
      // PID is the last number on the line.
      const lines = output.trim().split('\n');
      if (lines.length > 0) {
        const firstLine = lines[0];
        const parts = firstLine.trim().split(/\s+/);
        const pid = parts[parts.length - 1];

        if (pid && !isNaN(parseInt(pid))) {
          console.log(`Attempting to kill process with PID: ${pid} using port ${portToFree}`);
          try {
            execSync(`taskkill /PID ${pid} /F`);
            console.log(`Successfully killed process ${pid} using port ${portToFree}.`);
            logAdminMessage('PORT_KILLED', `PORT_${portToFree}`, { port: portToFree, pid: pid, status: 'success' })
              .catch(err => console.error("ADMIN_LOG_ERROR (PORT_KILLED):", err));
          } catch (killError) {
            console.error(`Failed to kill process ${pid} using port ${portToFree}:`, killError);
            logAdminMessage('PORT_KILL_FAILED', `PORT_${portToFree}`, { port: portToFree, pid: pid, status: 'failure', error: (killError as Error).message })
              .catch(err => console.error("ADMIN_LOG_ERROR (PORT_KILL_FAILED):", err));
          }
        } else {
          console.warn(`Could not extract a valid PID for port ${portToFree} from netstat output: ${firstLine}`);
        }
      } else {
        console.log(`No process found listening on port ${portToFree} from netstat output.`);
      }
    } else {
      console.log(`Port ${portToFree} is free.`);
    }
  } catch (error: any) {
    // If findstr returns an error, it usually means the port is not found / not in use.
    if (error.status === 1) { // findstr exits with 1 if string not found
      console.log(`Port ${portToFree} appears to be free (netstat/findstr did not find it).`);
    } else {
      console.error(`Error checking port ${portToFree}:`, error.message);
    }
  }
}

// Start the server
async function startServer() {
  // Handle potential port conflict before starting the server
  handlePortConflict(PORT, autoKillPort);

  server.listen(PORT, () => {
    console.log(`OpenAI-compatible relay server running on port ${PORT}`);
    console.log(`WebSocket server for browser extensions running on ws://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
