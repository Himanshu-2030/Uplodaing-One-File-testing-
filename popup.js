// popup.js
// FIXED: Enhanced popup with proper Google Drive sync and no duplication

class ModernMemorySearch {
  constructor() {
    this.searchInput = document.getElementById("searchInput");
    this.resultsContainer = document.getElementById("results");
    this.emptyState = document.getElementById("emptyState");
    this.resultCount = document.getElementById("resultCount");
    this.tagFilters = document.getElementById("tagFilters");

    this.allMemories = [];
    this.filteredMemories = [];
    this.allTags = new Set();
    this.selectedTags = new Set();
    this.editingCard = null;
    this.saveTimeouts = new Map();

    // Google Drive status
    this.isGoogleDriveConnected = false;
    this.userInfo = null;
    this.syncStatus = "idle";

    // Consistent tags with icons
    this.tagIcons = {
      important: "⭐",
      friend: "👥",
      alumni: "🎓",
      event: "📅",
      conference: "🎤",
    };

    this.init();
  }

  async init() {
    await this.loadMemories();
    this.setupEventListeners();
    this.populateTagFilters();
    this.showLastAddedNote();
    await this.setupGoogleDriveSync();
  }

  async setupGoogleDriveSync() {
    const connectBtn = document.getElementById("connectGoogle");
    const connectedDiv = document.getElementById("googleConnected");
    const userAvatar = document.getElementById("userAvatar");

    // Check if already connected
    await this.checkGoogleDriveStatus();

    // Connect button click
    if (connectBtn) {
      connectBtn.addEventListener("click", async () => {
        await this.connectGoogleDrive();
      });
    }

    // User avatar click - Direct disconnect
    if (userAvatar) {
      userAvatar.addEventListener("click", async () => {
        await this.disconnectGoogleDrive();
      });
    }
  }

  async checkGoogleDriveStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "getGoogleDriveStatus",
      });

      if (response.success && response.data.connected) {
        this.isGoogleDriveConnected = true;
        this.userInfo = response.data.userInfo;
        this.showConnectedState();
      } else {
        this.showDisconnectedState();
      }
    } catch (error) {
      console.error("Error checking Google Drive status:", error);
      this.showDisconnectedState();
    }
  }

  async connectGoogleDrive() {
    const connectBtn = document.getElementById("connectGoogle");
    const originalText = connectBtn.textContent;

    try {
      connectBtn.textContent = "Connecting...";
      connectBtn.disabled = true;

      // Show sync overlay
      this.showSyncOverlay(
        "Connecting to Google Drive...",
        "Please wait while we set up your connection"
      );

      // Request authentication from background script
      const response = await chrome.runtime.sendMessage({
        type: "connectGoogleDrive",
      });

      if (response.success) {
        this.isGoogleDriveConnected = true;
        this.userInfo = response.userInfo;

        // Update sync overlay for data loading
        this.updateSyncOverlay(
          "Syncing your memories...",
          `Found ${response.syncResult.localCount} local, ${response.syncResult.driveCount} from Drive`
        );

        // Show connected state
        this.showConnectedState();

        // CRITICAL: Reload and refresh data in real-time
        console.log("🔄 Reloading memories after sync...");
        await this.loadMemories();
        console.log("📚 Memories loaded:", this.allMemories.length);

        this.populateTagFilters();
        console.log("🏷️ Tag filters populated");

        // Force a complete re-render
        this.filteredMemories = [...this.allMemories];
        this.render();
        console.log("🎨 UI re-rendered");

        // Force update the result count and hide empty state
        this.updateResultCount();
        if (this.filteredMemories.length > 0) {
          this.hideEmptyState();
          this.renderResults();
        } else {
          this.showEmptyState();
        }

        // Update sync overlay for completion
        this.updateSyncOverlay(
          "Sync completed!",
          `${response.syncResult.mergedCount} memories synced successfully`
        );

        // Hide overlay after showing success
        setTimeout(() => {
          this.hideSyncOverlay();
          this.showNotification(
            `✅ Connected! Synced ${response.syncResult.mergedCount} profiles`,
            "success"
          );
        }, 1500);
      } else {
        throw new Error(response.error || "Connection failed");
      }
    } catch (error) {
      console.error("Google Drive connection failed:", error);
      this.hideSyncOverlay();
      this.showNotification("❌ Connection failed: " + error.message, "error");
    } finally {
      connectBtn.textContent = originalText;
      connectBtn.disabled = false;
    }
  }

  // FIXED: Enhanced auto-save with better sync
  async handleAutoSave(memory, newNote, card, saveIndicator) {
    const storageKey = memory.storageKey;

    // Clear existing timeout for this card
    if (this.saveTimeouts.has(storageKey)) {
      clearTimeout(this.saveTimeouts.get(storageKey));
    }

    // Show saving status
    saveIndicator.classList.add("show", "saving");
    saveIndicator.querySelector(".indicator-text").textContent = "Saving...";

    // Set new timeout for auto-save
    const timeout = setTimeout(async () => {
      try {
        const updatedMemory = {
          ...memory,
          note: newNote.trim(),
          tags: this.extractTagsFromNote(newNote.trim()),
          updatedAt: Date.now(),
        };

        await chrome.storage.local.set({ [storageKey]: updatedMemory });

        // Update local data immediately
        const index = this.allMemories.findIndex(
          (m) => m.storageKey === storageKey
        );
        if (index !== -1) {
          this.allMemories[index] = updatedMemory;
        }

        // Update the card display
        this.updateCardDisplay(card, updatedMemory);

        // Show saved status
        saveIndicator.classList.remove("saving");
        saveIndicator.classList.add("saved");
        saveIndicator.querySelector(".indicator-text").textContent =
          "Changes saved";

        // Trigger Google Drive sync if connected
        if (this.isGoogleDriveConnected) {
          this.queueGoogleDriveSync();
        }

        // Hide indicator after 2 seconds
        setTimeout(() => {
          saveIndicator.classList.remove("show", "saved");
        }, 2000);

        // Update tags in filters
        await this.loadMemories();
        this.populateTagFilters();

        // Notify content script about the update
        this.notifyContentScript(
          "memoryUpdated",
          updatedMemory.url,
          updatedMemory
        );
      } catch (error) {
        console.error("Error auto-saving:", error);
        saveIndicator.classList.remove("saving");
        saveIndicator.classList.add("error");
        saveIndicator.querySelector(".indicator-text").textContent =
          "Save failed";

        setTimeout(() => {
          saveIndicator.classList.remove("show", "error");
        }, 3000);
      }

      this.saveTimeouts.delete(storageKey);
    }, 500);

    this.saveTimeouts.set(storageKey, timeout);
  }

  // Queue Google Drive sync to avoid too frequent calls
  queueGoogleDriveSync() {
    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.backgroundSyncToGoogleDrive();
    }, 3000);
  }

  async backgroundSyncToGoogleDrive() {
    if (!this.isGoogleDriveConnected) return;

    try {
      this.setSyncStatus("syncing");

      const response = await chrome.runtime.sendMessage({
        type: "backupToGoogleDrive",
      });

      if (response.success) {
        this.setSyncStatus("synced");
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      console.error("Background sync failed:", error);
      this.setSyncStatus("error");
    }
  }

  setSyncStatus(status) {
    this.syncStatus = status;
    const syncStatusIcon = document.getElementById("syncStatusIcon");

    if (!syncStatusIcon) return;

    switch (status) {
      case "syncing":
        syncStatusIcon.textContent = "🟡";
        syncStatusIcon.title = "Syncing with Google Drive...";
        syncStatusIcon.style.animation = "spin 1s linear infinite";
        break;
      case "synced":
        syncStatusIcon.textContent = "🟢";
        syncStatusIcon.title = "Synced with Google Drive";
        syncStatusIcon.style.animation = "";
        break;
      case "error":
        syncStatusIcon.textContent = "🔴";
        syncStatusIcon.title = "Sync failed - Click to retry";
        syncStatusIcon.style.animation = "";
        syncStatusIcon.style.cursor = "pointer";
        syncStatusIcon.onclick = () => this.backgroundSyncToGoogleDrive();
        break;
      default:
        syncStatusIcon.textContent = "🟢";
        syncStatusIcon.title = "Connected to Google Drive";
        syncStatusIcon.style.animation = "";
    }
  }

  showConnectedState() {
    const connectBtn = document.getElementById("connectGoogle");
    const connectedDiv = document.getElementById("googleConnected");
    const userAvatar = document.getElementById("userAvatar");

    connectBtn.classList.add("hidden");
    connectedDiv.classList.remove("hidden");

    if (this.userInfo && this.userInfo.picture) {
      userAvatar.src = this.userInfo.picture;
      userAvatar.title = `Connected as ${
        this.userInfo.name || this.userInfo.email
      }\nClick to disconnect`;
    } else {
      userAvatar.src =
        "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM0Mjg1RjQiLz4KPHBhdGggZD0iTTE2IDhBOCA4IDAgMCAwIDggMTZhOCA4IDAgMCAwIDggOCA4IDggMCAwIDAgOC04IDggOCAwIDAgMC04LTh6bTAgM2EyLjUgMi41IDAgMCAxIDAgNSAyLjUgMi41IDAgMCAxIDAtNXptMCAxM2MtMiAwLTMuNzUtMS00LjUtMi5DQzExLjUgMTkuNSAxMy41IDE4IDE2IDE4czQuNSAxLjUgNC41IDMuNUMxOS43NSAyMyAxOCAyNCAxNiAyNHoiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=";
      userAvatar.title = "Connected to Google Drive\nClick to disconnect";
    }

    this.setSyncStatus("idle");
  }

  showDisconnectedState() {
    const connectBtn = document.getElementById("connectGoogle");
    const connectedDiv = document.getElementById("googleConnected");

    connectBtn.classList.remove("hidden");
    connectedDiv.classList.add("hidden");

    this.isGoogleDriveConnected = false;
    this.userInfo = null;
    this.syncStatus = "idle";
  }

  async disconnectGoogleDrive() {
    const result = await this.showCustomModal();

    if (result.action !== "disconnect") return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "disconnectGoogleDrive",
      });

      if (response.success) {
        this.showDisconnectedState();
        this.showNotification("🔌 Disconnected from Google Drive", "info");
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      console.error("Disconnect failed:", error);
      this.showNotification("❌ Disconnect failed: " + error.message, "error");
    }
  }

  showCustomModal() {
    return new Promise((resolve) => {
      const modal = document.getElementById("customModal");
      const cancelBtn = document.getElementById("cancelBtn");
      const disconnectBtn = document.getElementById("disconnectBtn");

      // Show modal
      modal.classList.add("show");

      const cleanup = () => {
        modal.classList.remove("show");
        cancelBtn.removeEventListener("click", handleCancel);
        disconnectBtn.removeEventListener("click", handleDisconnect);
      };

      const handleCancel = () => {
        cleanup();
        resolve({ action: "cancel" });
      };

      const handleDisconnect = () => {
        cleanup();
        resolve({ action: "disconnect" });
      };

      cancelBtn.addEventListener("click", handleCancel);
      disconnectBtn.addEventListener("click", handleDisconnect);

      // Close on overlay click
      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          handleCancel();
        }
      });
    });
  }

  showNotification(message, type, clickCallback = null) {
    // Remove existing notifications
    const existingNotifications = document.querySelectorAll(".notification");
    existingNotifications.forEach((notification) => {
      this.removeNotification(notification);
    });

    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;

    if (clickCallback) {
      notification.style.cursor = "pointer";
      notification.addEventListener("click", clickCallback);
    }

    notification.innerHTML = `
      <div class="notification-content">
        <span class="notification-message">${message}</span>
        <button class="notification-close">×</button>
      </div>
    `;

    // Add styles if not already added
    if (!document.getElementById("notification-styles")) {
      const styles = document.createElement("style");
      styles.id = "notification-styles";
      styles.textContent = `
        .notification {
          position: fixed;
          top: 20px;
          right: 20px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
          z-index: 1000;
          min-width: 280px;
          max-width: 350px;
          animation: slideInFromRight 0.3s ease-out;
        }
        
        .notification-success { border-left: 4px solid #38a169; }
        .notification-error { border-left: 4px solid #e53e3e; }
        .notification-info { border-left: 4px solid #3182ce; }
        
        .notification-content {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
        }
        
        .notification-message {
          font-size: 13px;
          color: #2d3748;
          font-weight: 500;
          line-height: 1.4;
        }
        
        .notification-close {
          background: none;
          border: none;
          font-size: 16px;
          color: #a0aec0;
          cursor: pointer;
          padding: 0;
          margin-left: 12px;
          flex-shrink: 0;
        }
        
        .notification-close:hover { color: #2d3748; }
        
        @keyframes slideInFromRight {
          from { opacity: 0; transform: translateX(100%); }
          to { opacity: 1; transform: translateX(0); }
        }
        
        @keyframes slideOutToRight {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(100%); }
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(styles);
    }

    document.body.appendChild(notification);

    const closeBtn = notification.querySelector(".notification-close");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeNotification(notification);
    });

    setTimeout(() => {
      this.removeNotification(notification);
    }, 4000);
  }

  removeNotification(notification) {
    if (notification && notification.parentNode) {
      notification.style.animation = "slideOutToRight 0.3s ease-out";
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }
  }

  // ADD THESE 3 METHODS RIGHT HERE:
  showSyncOverlay(message = "Syncing with Google Drive...", details = "") {
    const overlay = document.createElement("div");
    overlay.id = "syncOverlay";
    overlay.className = "sync-overlay";

    overlay.innerHTML = `
      <div class="sync-animation"></div>
      <div class="sync-message">${message}</div>
      ${details ? `<div class="sync-details">${details}</div>` : ""}
    `;

    const container = document.querySelector(".container") || document.body;
    container.appendChild(overlay);
  }

  hideSyncOverlay() {
    const overlay = document.getElementById("syncOverlay");
    if (overlay) {
      overlay.style.opacity = "0";
      setTimeout(() => {
        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
      }, 300);
    }
  }

  updateSyncOverlay(message, details = "") {
    const overlay = document.getElementById("syncOverlay");
    if (overlay) {
      const messageEl = overlay.querySelector(".sync-message");
      const detailsEl = overlay.querySelector(".sync-details");

      if (messageEl) messageEl.textContent = message;
      if (detailsEl) detailsEl.textContent = details;
    }
  }

  // ===== FIXED Memory Loading =====
  async loadMemories() {
    try {
      const result = await chrome.storage.local.get(null);

      // FIXED: Only get memories from local storage (no duplication)
      this.allMemories = Object.entries(result)
        .filter(
          ([key]) =>
            key.startsWith("lnms_") &&
            !key.includes("settings") &&
            !key.includes("google")
        )
        .map(([key, value]) => ({
          ...value,
          storageKey: key,
        }))
        .sort(
          (a, b) =>
            (b.updatedAt || b.createdAt || 0) -
            (a.updatedAt || a.createdAt || 0)
        );

      // Collect all unique tags
      this.allTags.clear();
      this.allMemories.forEach((memory) => {
        (memory.tags || []).forEach((tag) => this.allTags.add(tag));
      });

      console.log(
        `📚 Loaded ${this.allMemories.length} memories from local storage`
      );

      // ADD THIS LINE TO FORCE UPDATE THE FILTERED MEMORIES
      this.filteredMemories = [...this.allMemories];
    } catch (error) {
      console.error("Error loading memories:", error);
      this.allMemories = [];
      this.filteredMemories = [];
    }
  }

  populateTagFilters() {
    this.tagFilters.innerHTML = "";

    // Add "All" filter first
    const allTag = document.createElement("span");
    allTag.className = "filter-tag active";
    allTag.dataset.tag = "";
    allTag.textContent = "All";
    this.tagFilters.appendChild(allTag);

    // Use consistent tags from our defined set
    const consistentTags = [
      "important",
      "friend",
      "alumni",
      "event",
      "conference",
    ];

    consistentTags.forEach((tag) => {
      if (this.allTags.has(tag) || consistentTags.includes(tag)) {
        const filterTag = document.createElement("span");
        filterTag.className = "filter-tag";
        filterTag.dataset.tag = tag;
        filterTag.innerHTML = `${this.tagIcons[tag] || "🏷️"} ${tag}`;
        this.tagFilters.appendChild(filterTag);
      }
    });

    // Add event listeners to filter tags
    this.tagFilters.querySelectorAll(".filter-tag").forEach((tag) => {
      tag.addEventListener("click", () => {
        this.toggleTagFilter(tag);
      });
    });
  }

  toggleTagFilter(clickedTag) {
    const tag = clickedTag.dataset.tag;

    if (tag === "") {
      // "All" button clicked
      this.selectedTags.clear();
      this.tagFilters
        .querySelectorAll(".filter-tag")
        .forEach((t) => t.classList.remove("active"));
      clickedTag.classList.add("active");
    } else {
      // Specific tag clicked
      const allButton = this.tagFilters.querySelector('[data-tag=""]');
      allButton.classList.remove("active");

      if (this.selectedTags.has(tag)) {
        this.selectedTags.delete(tag);
        clickedTag.classList.remove("active");

        if (this.selectedTags.size === 0) {
          allButton.classList.add("active");
        }
      } else {
        this.selectedTags.add(tag);
        clickedTag.classList.add("active");
      }
    }

    this.applyFilters();
  }

  setupEventListeners() {
    this.searchInput.addEventListener("input", () => {
      this.applyFilters();
    });

    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.openFirstResult();
      }
    });

    setTimeout(() => this.searchInput.focus(), 100);
  }

  showLastAddedNote() {
    if (this.allMemories.length > 0) {
      this.filteredMemories = [...this.allMemories];
      this.render();
    } else {
      this.showEmptyState();
    }
  }

  applyFilters() {
    const query = this.searchInput.value.trim().toLowerCase();

    if (!query && this.selectedTags.size === 0) {
      this.filteredMemories = [...this.allMemories];
      this.render();
      return;
    }

    const terms = query ? query.split(/\s+/) : [];

    this.filteredMemories = this.allMemories.filter((memory) => {
      // Check search terms
      let matchesSearch = true;
      if (terms.length > 0) {
        const searchableText = [
          memory.name,
          memory.title,
          memory.company,
          memory.education,
          memory.bio,
          memory.note,
          ...(memory.tags || []),
        ]
          .join(" ")
          .toLowerCase();
        matchesSearch = terms.every((term) => searchableText.includes(term));
      }

      // Check selected tags
      let matchesTags = true;
      if (this.selectedTags.size > 0) {
        const memoryTags = memory.tags || [];
        matchesTags = Array.from(this.selectedTags).some((tag) =>
          memoryTags.includes(tag)
        );
      }

      return matchesSearch && matchesTags;
    });

    this.render();
  }

  render() {
    this.updateResultCount();

    if (this.filteredMemories.length === 0) {
      this.showEmptyState();
    } else {
      this.hideEmptyState();
      this.renderResults();
    }

    // ADD THIS LINE TO FORCE REFRESH THE DOM
    console.log("🎨 Rendered", this.filteredMemories.length, "memories");
  }

  updateResultCount() {
    const count = this.filteredMemories.length;
    this.resultCount.textContent =
      count === 1 ? "1 memory" : `${count} memories`;
  }

  showEmptyState() {
    this.emptyState.classList.add("show");
    this.resultsContainer.innerHTML = "";
  }

  hideEmptyState() {
    this.emptyState.classList.remove("show");
  }

  renderResults() {
    this.resultsContainer.innerHTML = "";

    this.filteredMemories.forEach((memory) => {
      const card = this.createResultCard(memory);
      this.resultsContainer.appendChild(card);
    });
  }

  createResultCard(memory) {
    const card = document.createElement("div");
    card.className = "result-card";
    card.dataset.storageKey = memory.storageKey;

    const formattedDate = this.formatDate(memory.updatedAt);
    const tags = memory.tags || [];
    const tagsHTML = tags
      .map((tag) => {
        const icon = this.tagIcons[tag] || "🏷️";
        return `<span class="tag">${icon} ${tag}</span>`;
      })
      .join("");

    // FIXED: Create comprehensive LinkedIn bio string
    const bioDetails = [memory.title, memory.company, memory.education]
      .filter((item) => item && item.trim())
      .join(" • ");

    card.innerHTML = `
      <div class="card-content">
        <div class="card-header">
          <div class="person-info">
            <div class="person-name">${this.escapeHTML(
              memory.name || "Unknown"
            )}</div>
            <div class="person-bio">${this.escapeHTML(bioDetails)}</div>
          </div>
          <div class="card-actions">
            <button class="action-btn edit" title="Edit note">✏️</button>
            <button class="action-btn delete" title="Delete memory">🗑️</button>
          </div>
        </div>
        
        ${
          memory.note
            ? `<div class="note-text">${this.escapeHTML(memory.note)}</div>`
            : ""
        }
        
        <div class="card-footer">
          <div class="tags-container">${tagsHTML}</div>
          <div class="date-info">${formattedDate}</div>
        </div>
      </div>
      
      <div class="edit-mode">
        <div class="edit-profile-info">
          <div class="edit-profile-name">${this.escapeHTML(
            memory.name || "Unknown"
          )}</div>
          <div class="edit-profile-details">${this.escapeHTML(bioDetails)}</div>
        </div>
        
        <div class="edit-tags-section">
          <div class="edit-quick-tags">
            ${this.getQuickTagsHTML()}
          </div>
        </div>
        
        <textarea 
          class="edit-textarea" 
          placeholder="Type your memory here..."
          data-storage-key="${memory.storageKey}"
        >${this.escapeHTML(memory.note || "")}</textarea>
        
        <div class="edit-note-hint">💡 Use #tags to organize memories</div>
        
        <div class="save-indicator">
          <span class="indicator-text">Changes saved</span>
        </div>
      </div>
    `;

    this.setupCardEventListeners(card, memory);
    return card;
  }

  getQuickTagsHTML() {
    const quickTags = ["important", "friend", "alumni", "event", "conference"];
    return quickTags
      .map(
        (tag) =>
          `<span class="edit-quick-tag" data-tag="${tag}">${this.tagIcons[tag]} ${tag}</span>`
      )
      .join("");
  }

  setupCardEventListeners(card, memory) {
    const cardContent = card.querySelector(".card-content");
    const editBtn = card.querySelector(".action-btn.edit");
    const deleteBtn = card.querySelector(".action-btn.delete");
    const editTextarea = card.querySelector(".edit-textarea");
    const saveIndicator = card.querySelector(".save-indicator");

    // Click to open profile
    cardContent.addEventListener("click", (e) => {
      if (!e.target.closest(".action-btn")) {
        this.openProfile(memory.url);
      }
    });

    // Edit button
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.enterEditMode(card, memory);
    });

    // Delete button
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteMemory(memory, card);
    });

    // Auto-save on typing
    editTextarea.addEventListener("input", () => {
      this.handleAutoSave(memory, editTextarea.value, card, saveIndicator);
      this.autoResizeTextarea(editTextarea);
    });

    // Exit edit mode on escape
    editTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.exitEditMode(card);
      }
    });
  }

  async deleteMemory(memory, card) {
    // Removed confirmation popup - direct deletion
    try {
      // Remove from storage
      await chrome.storage.local.remove(memory.storageKey);

      // Remove from local arrays
      this.allMemories = this.allMemories.filter(
        (m) => m.storageKey !== memory.storageKey
      );
      this.filteredMemories = this.filteredMemories.filter(
        (m) => m.storageKey !== memory.storageKey
      );

      // Remove card with animation
      card.style.animation = "slideOut 0.3s ease-out";
      setTimeout(() => {
        if (card.parentNode) {
          card.parentNode.removeChild(card);
        }
        this.render();
        this.populateTagFilters();
      }, 300);

      // Sync to Google Drive if connected
      if (this.isGoogleDriveConnected) {
        this.queueGoogleDriveSync();
      }

      // Notify content script
      this.notifyContentScript("memoryDeleted", memory.url);

      this.showNotification("🗑️ Memory deleted", "info");
    } catch (error) {
      console.error("Error deleting memory:", error);
      this.showNotification("❌ Failed to delete memory", "error");
    }
  }

  autoResizeTextarea(textarea) {
    textarea.style.height = "auto";
    const minHeight = 90;
    const maxHeight = 200;
    const newHeight = Math.max(
      minHeight,
      Math.min(maxHeight, textarea.scrollHeight)
    );
    textarea.style.height = newHeight + "px";
  }

  enterEditMode(card, memory) {
    if (this.editingCard && this.editingCard !== card) {
      this.exitEditMode(this.editingCard);
    }

    card.classList.add("editing");
    const editMode = card.querySelector(".edit-mode");
    const editTextarea = card.querySelector(".edit-textarea");

    editMode.classList.add("active");
    this.setupEditQuickTags(card, memory);
    this.autoResizeTextarea(editTextarea);
    editTextarea.focus();
    this.editingCard = card;
  }

  setupEditQuickTags(card, memory) {
    const quickTags = card.querySelectorAll(".edit-quick-tag");
    const editTextarea = card.querySelector(".edit-textarea");

    this.updateEditTagSelection(card);

    quickTags.forEach((tag) => {
      tag.addEventListener("click", () => {
        this.toggleEditQuickTag(tag, editTextarea, memory);
      });
    });
  }

  updateEditTagSelection(card) {
    const editTextarea = card.querySelector(".edit-textarea");
    if (!editTextarea) return;

    const noteText = editTextarea.value.toLowerCase();

    card.querySelectorAll(".edit-quick-tag").forEach((tag) => {
      const tagText = `#${tag.dataset.tag.toLowerCase()}`;
      if (noteText.includes(tagText)) {
        tag.classList.add("selected");
      } else {
        tag.classList.remove("selected");
      }
    });
  }

  toggleEditQuickTag(tagElement, editTextarea, memory) {
    const tag = tagElement.dataset.tag;
    const tagText = `#${tag.toLowerCase()}`;

    if (tagElement.classList.contains("selected")) {
      tagElement.classList.remove("selected");
      const currentNote = editTextarea.value;
      editTextarea.value = currentNote
        .replace(new RegExp(`\\s*${tagText}\\b`, "gi"), "")
        .trim();
    } else {
      tagElement.classList.add("selected");
      const currentNote = editTextarea.value;
      if (!currentNote.toLowerCase().includes(tagText)) {
        editTextarea.value = currentNote + (currentNote ? " " : "") + tagText;
      }
    }

    this.autoResizeTextarea(editTextarea);
    const card = tagElement.closest(".result-card");
    const saveIndicator = card.querySelector(".save-indicator");
    this.handleAutoSave(memory, editTextarea.value, card, saveIndicator);
    editTextarea.focus();
  }

  exitEditMode(card) {
    card.classList.remove("editing");
    card.querySelector(".edit-mode").classList.remove("active");

    const storageKey = card.dataset.storageKey;
    if (this.saveTimeouts.has(storageKey)) {
      clearTimeout(this.saveTimeouts.get(storageKey));
      this.saveTimeouts.delete(storageKey);
    }

    this.editingCard = null;
  }

  updateCardDisplay(card, memory) {
    // Update the main card content with new note
    const noteTextElement = card.querySelector(".note-text");
    const cardFooter = card.querySelector(".card-footer");

    if (memory.note && memory.note.trim()) {
      if (noteTextElement) {
        noteTextElement.textContent = memory.note;
      } else {
        const newNoteElement = document.createElement("div");
        newNoteElement.className = "note-text";
        newNoteElement.textContent = memory.note;

        const cardHeader = card.querySelector(".card-header");
        cardHeader.insertAdjacentElement("afterend", newNoteElement);
      }
    } else {
      if (noteTextElement) {
        noteTextElement.remove();
      }
    }

    // Update tags
    const tagsContainer = card.querySelector(".tags-container");
    const tags = memory.tags || [];
    const tagsHTML = tags
      .map((tag) => {
        const icon = this.tagIcons[tag] || "🏷️";
        return `<span class="tag">${icon} ${tag}</span>`;
      })
      .join("");

    tagsContainer.innerHTML = tagsHTML;

    // Update date
    const dateInfo = card.querySelector(".date-info");
    dateInfo.textContent = this.formatDate(memory.updatedAt);
  }

  async notifyContentScript(type, url, data = null) {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab && tab.url && tab.url.includes("linkedin.com")) {
        const message = { type, url };
        if (data) message.memory = data;

        await chrome.tabs.sendMessage(tab.id, message);
      }
    } catch (error) {
      console.log("Could not notify content script:", error.message);
    }
  }

  extractTagsFromNote(note) {
    const tagRegex = /#(\w+)/g;
    const tags = [];
    let match;

    while ((match = tagRegex.exec(note)) !== null) {
      tags.push(match[1]);
    }

    return [...new Set(tags)];
  }

  formatDate(timestamp) {
    if (!timestamp) return "Unknown";

    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  async openProfile(url) {
    try {
      await chrome.tabs.create({ url });
    } catch (error) {
      console.error("Error opening profile:", error);
    }
  }

  openFirstResult() {
    const firstCard = this.resultsContainer.querySelector(
      ".result-card .card-content"
    );
    if (firstCard) {
      firstCard.click();
    }
  }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new ModernMemorySearch();
});
