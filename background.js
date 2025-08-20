// background.js
// FIXED: Enhanced background service worker with proper Google Drive sync
// Fixes duplication, data integrity, and real-time updates

const GOOGLE_DRIVE_CONFIG = {
  fileName: "linkedin-memories.json",
  driveFilesEndpoint: "https://www.googleapis.com/drive/v3/files",
  driveUploadEndpoint: "https://www.googleapis.com/upload/drive/v3/files",
  userinfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
};

// Cached authentication state
let cachedAuth = {
  token: null,
  email: null,
  notesFileId: null,
  lastLoaded: 0,
};

class LinkedInMemoryBackground {
  constructor() {
    this.activeConnections = new Map();
    this.setupEventListeners();
  }

  setupEventListeners() {
    chrome.runtime.onInstalled.addListener((details) => {
      this.handleInstallation(details);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.handleTabUpdate(tabId, changeInfo, tab);
    });

    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.handleTabActivated(activeInfo);
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep message channel open for async responses
    });

    chrome.action.onClicked.addListener((tab) => {
      this.handleActionClick(tab);
    });
  }

  async handleMessage(message, sender, sendResponse) {
    try {
      switch (message.type) {
        case "connectGoogleDrive":
          console.log("🔗 Starting Google Drive connection...");
          const authResult = await this.authenticateGoogleDrive();
          sendResponse(authResult);
          break;

        case "backupToGoogleDrive":
          console.log("💾 Starting backup to Google Drive...");
          const backupResult = await this.backupMemoriesToDrive();
          sendResponse(backupResult);
          break;

        case "restoreFromGoogleDrive":
          console.log("📥 Starting restore from Google Drive...");
          const restoreResult = await this.restoreMemoriesFromDrive();
          sendResponse(restoreResult);
          break;

        case "syncGoogleDrive":
          console.log("🔄 Starting Google Drive sync...");
          const syncResult = await this.syncWithGoogleDrive();
          sendResponse(syncResult);
          break;

        case "disconnectGoogleDrive":
          console.log("🔌 Disconnecting from Google Drive...");
          const disconnectResult = await this.disconnectGoogleDrive();
          sendResponse(disconnectResult);
          break;

        case "getGoogleDriveStatus":
          const status = await this.getGoogleDriveStatus();
          sendResponse({ success: true, data: status });
          break;

        // Memory operations
        case "memoryUpdated":
        case "memoryDeleted":
          await this.handleMemoryChange(message, sender);
          sendResponse({ success: true });
          break;

        case "getMemoryStats":
          const stats = await this.getMemoryStats();
          sendResponse({ success: true, data: stats });
          break;

        case "exportMemories":
          const exportData = await this.exportMemories();
          sendResponse({ success: true, data: exportData });
          break;

        case "importMemories":
          const importResult = await this.importMemories(message.data);
          sendResponse({ success: true, data: importResult });
          break;

        default:
          sendResponse({ success: false, error: "Unknown message type" });
      }
    } catch (error) {
      console.error("❌ Error handling message:", error);
      sendResponse({ success: false, error: error.message });
    }
  }

  // ===== FIXED Google Drive Authentication =====
  async authenticateGoogleDrive() {
    try {
      console.log("🔐 Starting Google Drive authentication...");

      const token = await this.getAuthToken({ interactive: true });

      if (!token) {
        throw new Error("No authentication token received");
      }

      const userInfo = await this.getUserInfo(token);
      console.log("👤 Got user info:", userInfo.name, userInfo.email);

      // Cache auth data
      cachedAuth.token = token;
      cachedAuth.email = userInfo.email;

      // Store connection status
      await chrome.storage.local.set({
        lnms_google_auth: {
          connected: true,
          connectedAt: Date.now(),
          userInfo: userInfo,
          lastBackup: null,
        },
      });

      // CRITICAL: Perform intelligent sync on first connection
      const intelligentSyncResult = await this.performIntelligentSync();

      console.log("✅ Google Drive authentication + sync successful");

      return {
        success: true,
        userInfo: userInfo,
        syncResult: intelligentSyncResult,
        message: "Successfully connected to Google Drive!",
      };
    } catch (error) {
      console.error("❌ Google Drive authentication failed:", error);
      await this.clearAuthState();

      return {
        success: false,
        error: error.message || "Authentication failed",
      };
    }
  }

  // ===== FIXED: Intelligent Sync Logic =====
  async performIntelligentSync() {
    try {
      console.log("🧠 Starting intelligent sync...");

      // Get local memories
      const localMemories = await this.getAllLocalMemories();
      console.log(
        `📱 Found ${Object.keys(localMemories).length} local memories`
      );

      // Get Drive memories
      const driveMemories = await this.loadNotesFromDrive();
      console.log(
        `☁️ Found ${Object.keys(driveMemories).length} Drive memories`
      );

      // Merge logic: Keep the most recent version of each profile
      const mergedMemories = await this.intelligentMerge(
        localMemories,
        driveMemories
      );

      // Save merged data both locally and to Drive
      await this.saveMergedMemories(mergedMemories);

      // Notify all LinkedIn tabs to refresh their data
      await this.notifyAllLinkedInTabs();

      return {
        localCount: Object.keys(localMemories).length,
        driveCount: Object.keys(driveMemories).length,
        mergedCount: Object.keys(mergedMemories).length,
        message: "Intelligent sync completed",
      };
    } catch (error) {
      console.error("❌ Intelligent sync failed:", error);
      throw error;
    }
  }

  async getAllLocalMemories() {
    const allLocalData = await chrome.storage.local.get(null);
    const memories = {};

    Object.entries(allLocalData)
      .filter(
        ([key]) =>
          key.startsWith("lnms_") &&
          !key.includes("settings") &&
          !key.includes("google")
      )
      .forEach(([storageKey, memory]) => {
        // ✅ Use storage key directly
        memories[storageKey] = {
          ...memory,
          storageKey: storageKey,
          source: "local",
        };
      });

    return memories;
  }

  async intelligentMerge(localMemories, driveMemories) {
    const merged = {};

    // Get all unique profile keys
    const allProfileKeys = new Set([
      ...Object.keys(localMemories),
      ...Object.keys(driveMemories),
    ]);

    for (const profileKey of allProfileKeys) {
      const localMemory = localMemories[profileKey];
      const driveMemory = driveMemories[profileKey];

      if (localMemory && driveMemory) {
        // Both exist - merge intelligently
        const localTime = localMemory.updatedAt || localMemory.createdAt || 0;
        const driveTime = new Date(
          driveMemory.updatedAt || driveMemory.createdAt || 0
        ).getTime();

        if (localTime > driveTime) {
          // Local is newer - keep local but ensure it has full profile data
          merged[profileKey] = this.ensureCompleteMemoryData(localMemory);
          console.log(`🔄 Keeping newer local memory for ${localMemory.name}`);
        } else {
          // Drive is newer - restore drive version with proper structure
          merged[profileKey] = this.convertDriveToLocalFormat(
            driveMemory,
            localMemory
          );
          console.log(`☁️ Keeping newer Drive memory for ${driveMemory.name}`);
        }
      } else if (localMemory) {
        // Only local exists - keep it
        merged[profileKey] = this.ensureCompleteMemoryData(localMemory);
        console.log(`📱 Keeping local-only memory for ${localMemory.name}`);
      } else if (driveMemory) {
        // Only Drive exists - restore it
        merged[profileKey] = this.convertDriveToLocalFormat(driveMemory);
        console.log(`☁️ Restoring Drive-only memory for ${driveMemory.name}`);
      }
    }

    return merged;
  }

  convertDriveToLocalFormat(driveMemory, existingLocal = null) {
  const cleanUrl = driveMemory.url.split("?")[0].replace(/\\/$/g, "");
  const storageKey = `lnms_${btoa(cleanUrl).replace(/[^a-zA-Z0-9]/g, "")}`;

  return {
    name: driveMemory.name || existingLocal?.name || "LinkedIn User",
    title: driveMemory.profileData?.title || driveMemory.title || existingLocal?.title || "",
    company: driveMemory.profileData?.company || driveMemory.company || existingLocal?.company || "",
    location: driveMemory.profileData?.location || driveMemory.location || existingLocal?.location || "",
    education: driveMemory.profileData?.education || driveMemory.education || existingLocal?.education || "",
    bio: driveMemory.profileData?.bio || driveMemory.bio || existingLocal?.bio || "",
    
    url: driveMemory.url,
    note: driveMemory.note || "",
    tags: this.parseTagsFromString(driveMemory.tags || ""),
    updatedAt: new Date(driveMemory.updatedAt || Date.now()).getTime(),
    createdAt: existingLocal?.createdAt || new Date(driveMemory.createdAt || driveMemory.updatedAt || Date.now()).getTime(),
    storageKey: storageKey,
    source: "drive"
  };
}

  ensureCompleteMemoryData(memory) {
    // Ensure memory has all required fields
    return {
      name: memory.name || "LinkedIn User",
      title: memory.title || "",
      company: memory.company || "",
      location: memory.location || "",
      education: memory.education || "",
      bio: memory.bio || "",
      url: memory.url,
      note: memory.note || "",
      tags: memory.tags || [],
      updatedAt: memory.updatedAt || Date.now(),
      createdAt: memory.createdAt || memory.updatedAt || Date.now(),
      storageKey: memory.storageKey,
    };
  }

  async saveMergedMemories(mergedMemories) {
    console.log(
      `💾 Saving ${Object.keys(mergedMemories).length} merged memories...`
    );

    // Prepare local storage updates
    const localStorageUpdates = {};
    const driveMemoriesFormatted = {};

    for (const [profileKey, memory] of Object.entries(mergedMemories)) {
      // Save to local storage format
      localStorageUpdates[memory.storageKey] = {
        name: memory.name,
        title: memory.title,
        company: memory.company,
        location: memory.location,
        education: memory.education,
        bio: memory.bio,
        url: memory.url,
        note: memory.note,
        tags: memory.tags,
        updatedAt: memory.updatedAt,
        createdAt: memory.createdAt,
        storageKey: memory.storageKey,
      };

      // Prepare for Drive storage format
      
      driveMemoriesFormatted[profileKey] = {
      name: memory.name,
      url: memory.url,
      note: memory.note,
      tags: memory.tags.join(", "),
      
      // ADD THIS BLOCK - Store complete profile data
      profileData: {
        title: memory.title,
        company: memory.company,
        location: memory.location,
        education: memory.education,
        bio: memory.bio,
      },
      
      updatedAt: new Date(memory.updatedAt).toISOString(),
      createdAt: new Date(memory.createdAt).toISOString(),
      };
    }

    // Save to local storage
    await chrome.storage.local.set(localStorageUpdates);
    console.log("✅ Local storage updated");

    // Save to Drive
    await this.saveNotesToDrive(driveMemoriesFormatted);
    console.log("☁️ Drive storage updated");

    // Update last backup time
    const authData = await chrome.storage.local.get("lnms_google_auth");
    await chrome.storage.local.set({
      lnms_google_auth: {
        ...authData.lnms_google_auth,
        lastBackup: Date.now(),
      },
    });
  }

  getProfileKeyFromUrl(url) {
    // Create consistent profile key from URL - MUST match content script logic
    try {
      const cleanUrl = url.split("?")[0].replace(/\/$/, "");
      return `lnms_${btoa(cleanUrl).replace(/[^a-zA-Z0-9]/g, "")}`;
    } catch (error) {
      console.error("Error creating profile key:", url, error);
      return `lnms_${btoa(url.split("?")[0]).replace(/[^a-zA-Z0-9]/g, "")}`;
    }
  }

  // ===== FIXED Backup Method =====
  async backupMemoriesToDrive() {
    try {
      if (!cachedAuth.token) {
        const authData = await chrome.storage.local.get("lnms_google_auth");
        if (authData.lnms_google_auth?.connected) {
          await this.getAuthToken({ interactive: false });
        } else {
          throw new Error("Not authenticated with Google Drive");
        }
      }

      // Get all local memories with complete data
      const localMemories = await this.getAllLocalMemories();

      // Convert to Drive format while preserving all data
      const driveMemoriesFormatted = {};

      for (const [profileKey, memory] of Object.entries(localMemories)) {
        driveMemoriesFormatted[profileKey] = {
          name: memory.name,
          url: memory.url,
          note: memory.note,
          tags: memory.tags.join(", "),

          // Store complete profile data
          profileData: {
            title: memory.title,
            company: memory.company,
            location: memory.location,
            education: memory.education,
            bio: memory.bio,
          },

          updatedAt: new Date(memory.updatedAt).toISOString(),
          createdAt: new Date(memory.createdAt).toISOString(),
        };
      }

      console.log(
        `💾 Backing up ${
          Object.keys(driveMemoriesFormatted).length
        } memories to Drive`
      );

      await this.saveNotesToDrive(driveMemoriesFormatted);

      // Update last backup time
      const authData = await chrome.storage.local.get("lnms_google_auth");
      await chrome.storage.local.set({
        lnms_google_auth: {
          ...authData.lnms_google_auth,
          lastBackup: Date.now(),
        },
      });

      return {
        success: true,
        message: `Backed up ${
          Object.keys(driveMemoriesFormatted).length
        } memories`,
        memoriesBackedUp: Object.keys(driveMemoriesFormatted).length,
      };
    } catch (error) {
      console.error("❌ Backup failed:", error);
      return { success: false, error: error.message };
    }
  }

  // ===== FIXED Restore Method =====
  async restoreMemoriesFromDrive() {
    try {
      if (!cachedAuth.token) {
        throw new Error("Not authenticated with Google Drive");
      }

      // Load notes from Drive
      const driveNotes = await this.loadNotesFromDrive();
      console.log(
        `📥 Found ${Object.keys(driveNotes).length} memories in Drive`
      );

      if (Object.keys(driveNotes).length === 0) {
        return {
          success: true,
          message: "No memories found in Google Drive",
          restored: 0,
        };
      }

      // Get current local memories for intelligent merge
      const localMemories = await this.getAllLocalMemories();

      let restored = 0;
      const memoriesToSave = {};
      const updatedUrls = []; // Track which profiles were updated

      // Process each Drive memory
      for (const [profileKey, driveMemory] of Object.entries(driveNotes)) {
        try {
          const cleanUrl = driveMemory.url.split("?")[0];
          const storageKey = `lnms_${btoa(cleanUrl).replace(
            /[^a-zA-Z0-9]/g,
            ""
          )}`;

          const existingLocal = localMemories[profileKey];
          const driveTime = new Date(driveMemory.updatedAt).getTime();
          const localTime = existingLocal
            ? existingLocal.updatedAt || existingLocal.createdAt || 0
            : 0;

          // Only restore if Drive version is newer OR if no local version exists
          const shouldRestore = !existingLocal || driveTime > localTime;

          if (shouldRestore) {
            const restoredMemory = {
              // Use stored profile data from Drive, fallback to existing local data
              name: driveMemory.name || existingLocal?.name || "LinkedIn User",
              title:
                driveMemory.profileData?.title || existingLocal?.title || "",
              company:
                driveMemory.profileData?.company ||
                existingLocal?.company ||
                "",
              location:
                driveMemory.profileData?.location ||
                existingLocal?.location ||
                "",
              education:
                driveMemory.profileData?.education ||
                existingLocal?.education ||
                "",
              bio: driveMemory.profileData?.bio || existingLocal?.bio || "",

              // Drive data for notes and tags
              url: driveMemory.url,
              note: driveMemory.note || "",
              tags: this.parseTagsFromString(driveMemory.tags || ""),

              // Timestamps
              updatedAt: driveTime,
              createdAt:
                existingLocal?.createdAt ||
                new Date(
                  driveMemory.createdAt || driveMemory.updatedAt
                ).getTime(),

              // Storage metadata
              storageKey: storageKey,
            };

            memoriesToSave[storageKey] = restoredMemory;
            updatedUrls.push(cleanUrl);
            restored++;

            console.log(
              `📥 Restoring: ${restoredMemory.name} (${
                driveTime > localTime ? "newer" : "new"
              })`
            );
          }
        } catch (error) {
          console.warn("Skipping invalid memory from Drive:", error);
        }
      }

      // Save all restored memories at once
      if (Object.keys(memoriesToSave).length > 0) {
        await chrome.storage.local.set(memoriesToSave);

        // Notify LinkedIn tabs about updates
        await this.notifyLinkedInTabsAboutUpdates(updatedUrls);
      }

      return {
        success: true,
        message:
          restored > 0
            ? `Restored ${restored} memories from Google Drive`
            : "All memories are up to date",
        restored: restored,
        updatedUrls: updatedUrls,
      };
    } catch (error) {
      console.error("❌ Restore failed:", error);
      return { success: false, error: error.message };
    }
  }

  // ===== NEW: Smart Tab Notification =====
  async notifyAllLinkedInTabs() {
    try {
      const tabs = await chrome.tabs.query({ url: "*://linkedin.com/*" });

      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "memoriesUpdated",
            action: "reload",
          });
          console.log(`📢 Notified tab ${tab.id} about memory updates`);
        } catch (error) {
          // Tab might not have content script loaded, ignore
          console.log(`Could not notify tab ${tab.id}:`, error.message);
        }
      }
    } catch (error) {
      console.error("Error notifying LinkedIn tabs:", error);
    }
  }

  async notifyLinkedInTabsAboutUpdates(updatedUrls) {
    try {
      const tabs = await chrome.tabs.query({ url: "*://linkedin.com/in/*" });

      for (const tab of tabs) {
        try {
          const tabUrl = tab.url.split("?")[0];
          const isAffectedProfile = updatedUrls.some(
            (url) =>
              tabUrl.includes(url) || url.includes(tabUrl.split("/in/")[1])
          );

          if (isAffectedProfile) {
            await chrome.tabs.sendMessage(tab.id, {
              type: "memoryRestored",
              url: tabUrl,
            });
            console.log(`📢 Notified affected tab: ${tab.url}`);
          }
        } catch (error) {
          console.log(`Could not notify tab ${tab.id}:`, error.message);
        }
      }
    } catch (error) {
      console.error("Error notifying specific LinkedIn tabs:", error);
    }
  }

  // ===== Auth Helper Methods =====
  async getAuthToken({ interactive = false } = {}) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        if (!token) {
          return reject(new Error("No token returned"));
        }

        if (cachedAuth.token && cachedAuth.token !== token) {
          chrome.identity.removeCachedAuthToken(
            { token: cachedAuth.token },
            () => {}
          );
        }

        cachedAuth.token = token;
        resolve(token);
      });
    });
  }

  async getUserInfo(token) {
    const response = await fetch(GOOGLE_DRIVE_CONFIG.userinfoEndpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to get user info: ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  }

  async driveApi(method, url, { params = {}, headers = {}, body } = {}) {
    const token =
      cachedAuth.token || (await this.getAuthToken({ interactive: false }));
    const qs = new URLSearchParams(params).toString();
    const fullUrl = qs ? `${url}?${qs}` : url;

    const response = await fetch(fullUrl, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Drive API ${method} ${url} failed: ${response.status} ${text}`
      );
    }

    return response;
  }

  // ===== Drive File Operations =====
  async findNotesFileId() {
    if (cachedAuth.notesFileId) return cachedAuth.notesFileId;

    const response = await this.driveApi(
      "GET",
      GOOGLE_DRIVE_CONFIG.driveFilesEndpoint,
      {
        params: {
          spaces: "appDataFolder",
          q: `name='${GOOGLE_DRIVE_CONFIG.fileName}' and 'appDataFolder' in parents`,
          fields: "files(id, name)",
        },
      }
    );

    const data = await response.json();
    if (data.files && data.files.length > 0) {
      cachedAuth.notesFileId = data.files[0].id;
      return cachedAuth.notesFileId;
    }

    return null;
  }

  async createNotesFile() {
    const metadata = {
      name: GOOGLE_DRIVE_CONFIG.fileName,
      parents: ["appDataFolder"],
    };

    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const body =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({}) +
      closeDelim;

    const response = await this.driveApi(
      "POST",
      GOOGLE_DRIVE_CONFIG.driveUploadEndpoint,
      {
        params: { uploadType: "multipart" },
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      }
    );

    const data = await response.json();
    cachedAuth.notesFileId = data.id;
    return data.id;
  }

  async ensureNotesFile() {
    const id = await this.findNotesFileId();
    if (id) return id;
    return await this.createNotesFile();
  }

  async loadNotesFromDrive() {
    try {
      const fileId = await this.ensureNotesFile();
      const response = await this.driveApi(
        "GET",
        `${GOOGLE_DRIVE_CONFIG.driveFilesEndpoint}/${fileId}`,
        {
          params: { alt: "media" },
        }
      );

      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch (error) {
      console.warn("Error loading from Drive (might be empty):", error);
      return {};
    }
  }

  async saveNotesToDrive(notesObj) {
    const fileId = await this.ensureNotesFile();
    const body = new Blob([JSON.stringify(notesObj, null, 2)], {
      type: "application/json",
    });

    await this.driveApi(
      "PATCH",
      `${GOOGLE_DRIVE_CONFIG.driveUploadEndpoint}/${fileId}`,
      {
        params: { uploadType: "media" },
        headers: { "Content-Type": "application/json" },
        body,
      }
    );
  }

  // ===== FIXED Sync Method =====
  async syncWithGoogleDrive() {
    try {
      // Perform intelligent sync
      const syncResult = await this.performIntelligentSync();

      return {
        success: true,
        message: `Sync complete: ${syncResult.mergedCount} profiles synced`,
        ...syncResult,
      };
    } catch (error) {
      console.error("❌ Sync failed:", error);
      return { success: false, error: error.message };
    }
  }

  // ===== Disconnect Method =====
  async disconnectGoogleDrive() {
    try {
      console.log("🔌 Starting disconnect process...");

      if (cachedAuth.token) {
        try {
          await fetch(
            `https://oauth2.googleapis.com/revoke?token=${cachedAuth.token}`,
            {
              method: "POST",
              headers: { "Content-type": "application/x-www-form-urlencoded" },
            }
          );
        } catch (e) {
          console.log("Token revocation network error (ignored):", e.message);
        }

        await new Promise((resolve) => {
          chrome.identity.clearAllCachedAuthTokens(() => resolve());
        });
      }

      await this.clearAuthState();

      console.log("✅ Successfully disconnected from Google Drive");

      return {
        success: true,
        message: "Disconnected from Google Drive",
      };
    } catch (error) {
      console.error("❌ Disconnect failed:", error);
      return { success: false, error: error.message };
    }
  }

  async getGoogleDriveStatus() {
    try {
      const authData = await chrome.storage.local.get("lnms_google_auth");

      if (authData.lnms_google_auth?.connected) {
        try {
          await this.getAuthToken({ interactive: false });
          return {
            connected: true,
            userInfo: authData.lnms_google_auth.userInfo,
            connectedAt: authData.lnms_google_auth.connectedAt,
            lastBackup: authData.lnms_google_auth.lastBackup,
          };
        } catch (error) {
          await this.clearAuthState();
          return { connected: false };
        }
      }

      return { connected: false };
    } catch (error) {
      console.error("Error checking Google Drive status:", error);
      return { connected: false };
    }
  }

  async clearAuthState() {
    cachedAuth = { token: null, email: null, notesFileId: null, lastLoaded: 0 };
    await chrome.storage.local.remove("lnms_google_auth");
  }

  // ===== IMPROVED Memory Change Handling =====
  async handleMemoryChange(message, sender) {
    // Auto-sync to Google Drive if connected (with debouncing)
    if (await this.isGoogleDriveConnected()) {
      console.log("🔄 Auto-syncing after memory change...");
      clearTimeout(this.autoSyncTimeout);
      this.autoSyncTimeout = setTimeout(() => {
        this.backupMemoriesToDrive();
      }, 2000);
    }

    // Update badge for affected tabs
    if (message.url) {
      const tabs = await chrome.tabs.query({ url: "*://linkedin.com/in/*" });
      for (const tab of tabs) {
        if (tab.url && tab.url.startsWith(message.url.split("?")[0])) {
          await this.updateBadgeForTab(tab.id, tab.url);
        }
      }
    }
  }

  async isGoogleDriveConnected() {
    try {
      const authData = await chrome.storage.local.get("lnms_google_auth");
      return !!(authData.lnms_google_auth?.connected && cachedAuth.token);
    } catch (error) {
      return false;
    }
  }

  // ===== Utility Methods =====
  parseTagsFromString(tagsString) {
    if (!tagsString) return [];

    // Handle both comma-separated and space-separated tags
    if (tagsString.includes(",")) {
      return tagsString
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag);
    } else {
      // Extract hashtags from text
      const tagRegex = /#(\w+)/g;
      const tags = [];
      let match;
      while ((match = tagRegex.exec(tagsString)) !== null) {
        tags.push(match[1]);
      }
      return tags;
    }
  }

  async updateBadgeForTab(tabId, url) {
    try {
      const cleanUrl = url.split("?")[0];
      const storageKey = `lnms_${btoa(cleanUrl).replace(/[^a-zA-Z0-9]/g, "")}`;
      const result = await chrome.storage.local.get(storageKey);

      if (result[storageKey] && result[storageKey].note) {
        chrome.action.setBadgeText({ tabId: tabId, text: "●" });
        chrome.action.setBadgeBackgroundColor({
          tabId: tabId,
          color: "#667eea",
        });
        chrome.action.setTitle({
          tabId: tabId,
          title: "LinkedIn Memory Search - Memory saved for this profile",
        });
      } else {
        chrome.action.setBadgeText({ tabId: tabId, text: "" });
        chrome.action.setTitle({
          tabId: tabId,
          title: "LinkedIn Memory Search",
        });
      }
    } catch (error) {
      console.error("Error updating badge:", error);
    }
  }

  handleInstallation(details) {
    if (details.reason === "install") {
      console.log("LinkedIn Memory Search installed");
      chrome.storage.local.set({
        lnms_settings: {
          version: "1.0.0",
          installedAt: Date.now(),
          autoShow: true,
          quickTags: ["important", "friend", "alumni", "event", "conference"],
        },
      });
    }
  }

  async handleTabUpdate(tabId, changeInfo, tab) {
    if (
      changeInfo.status === "complete" &&
      tab.url &&
      tab.url.includes("linkedin.com")
    ) {
      await this.updateBadgeForTab(tabId, tab.url);
    }
  }

  async handleTabActivated(activeInfo) {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url && tab.url.includes("linkedin.com/in/")) {
        await this.updateBadgeForTab(activeInfo.tabId, tab.url);
      }
    } catch (error) {
      console.error("Error handling tab activation:", error);
    }
  }

  handleActionClick(tab) {
    // Default popup behavior
  }

  async getMemoryStats() {
    const allData = await chrome.storage.local.get(null);
    const memories = Object.entries(allData)
      .filter(
        ([key]) =>
          key.startsWith("lnms_") &&
          !key.includes("settings") &&
          !key.includes("google")
      )
      .map(([, value]) => value);

    return {
      totalMemories: memories.length,
      totalStorage: JSON.stringify(allData).length,
    };
  }

  async exportMemories() {
    const allData = await chrome.storage.local.get(null);
    const memories = Object.entries(allData)
      .filter(
        ([key]) =>
          key.startsWith("lnms_") &&
          !key.includes("settings") &&
          !key.includes("google")
      )
      .map(([, value]) => value);

    return {
      exportDate: Date.now(),
      version: "1.0.0",
      totalMemories: memories.length,
      memories: memories,
    };
  }

  async importMemories(importData) {
    if (!importData.memories || !Array.isArray(importData.memories)) {
      throw new Error("Invalid import data format");
    }

    let imported = 0;
    const memoriesToSave = {};

    for (const memory of importData.memories) {
      if (memory.url && memory.name) {
        try {
          const cleanUrl = memory.url.split("?")[0];
          const storageKey = `lnms_${btoa(cleanUrl).replace(
            /[^a-zA-Z0-9]/g,
            ""
          )}`;
          memoriesToSave[storageKey] = memory;
          imported++;
        } catch (error) {
          console.error("Error preparing memory for import:", error);
        }
      }
    }

    if (Object.keys(memoriesToSave).length > 0) {
      await chrome.storage.local.set(memoriesToSave);
    }

    return { imported };
  }
}

// Initialize the background service
const backgroundService = new LinkedInMemoryBackground();
console.log("🚀 LinkedIn Memory Search background service started");
