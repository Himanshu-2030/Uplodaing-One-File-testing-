// content.js
// FIXED: Enhanced content script with proper sync handling and no duplication

class LinkedInMemoryCard {
  constructor() {
    this.isLinkedInProfile = false;
    this.profileData = null;
    this.currentMemory = null;
    this.selectedTags = new Set();
    this.saveTimeout = null;
    this.navigationObserver = null;
    this.isInitialized = false;
    this.extractionTimeout = null;
    this.currentUrl = "";
    this.dataExtractionAttempts = 0;
    this.maxExtractionAttempts = 5;

    // Consistent tags across the extension
    this.quickTags = ["important", "friend", "alumni", "event", "conference"];

    // Draggable state
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };

    this.init();
  }

  init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.setup());
    } else {
      this.setup();
    }
  }

  setup() {
    if (this.extractionTimeout) {
      clearTimeout(this.extractionTimeout);
    }

    this.currentUrl = window.location.href;
    this.dataExtractionAttempts = 0;

    this.checkProfilePage();

    if (this.isLinkedInProfile) {
      this.attemptDataExtraction();
    } else {
      this.cleanup();
    }

    if (!this.navigationObserver) {
      this.observeNavigation();
    }
  }

  attemptDataExtraction() {
    this.dataExtractionAttempts++;

    const success = this.extractProfileData();

    if (
      success &&
      this.profileData &&
      this.profileData.name &&
      this.profileData.name !== "LinkedIn User"
    ) {
      console.log(
        "Profile data extracted successfully:",
        this.profileData.name
      );
      this.proceedWithCardCreation();
    } else if (this.dataExtractionAttempts < this.maxExtractionAttempts) {
      console.log(
        `Profile data extraction attempt ${this.dataExtractionAttempts} failed, retrying...`
      );
      this.extractionTimeout = setTimeout(() => {
        this.attemptDataExtraction();
      }, 1000 + this.dataExtractionAttempts * 500);
    } else {
      console.log("Failed to extract profile data after maximum attempts");
      this.cleanup();
    }
  }

  proceedWithCardCreation() {
    if (
      !this.profileData ||
      !this.profileData.name ||
      this.profileData.name === "LinkedIn User"
    ) {
      return;
    }

    this.cleanup();
    this.createMemoryCard();
    this.loadExistingMemory();
    this.isInitialized = true;
    this.setupMessageListener();
  }

  // ===== FIXED: Enhanced Message Listener =====
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("📨 Content script received message:", message.type);

      // Check if this message is relevant to current profile
      const isRelevantProfile =
        message.url &&
        (message.url === this.profileData?.url ||
          message.url.split("?")[0] === this.profileData?.url.split("?")[0]);

      switch (message.type) {
        case "memoryDeleted":
          if (isRelevantProfile) {
            console.log(
              "🗑️ Memory deleted from popup, updating content script"
            );
            this.currentMemory = null;
            this.resetCardForm();
            this.hideDeleteButton();
          }
          break;

        case "memoryUpdated":
          if (isRelevantProfile) {
            console.log(
              "📝 Memory updated from popup, updating content script"
            );
            this.currentMemory = message.memory;
            this.updateCardWithMemory(message.memory);
          }
          break;

        case "memoryRestored":
          if (isRelevantProfile) {
            console.log("📥 Memory restored from Google Drive, reloading");
            // Reload the memory from storage to get complete data
            this.loadExistingMemory();
          }
          break;

        case "memoriesUpdated":
          if (message.action === "reload") {
            console.log("🔄 Global memory update, reloading current profile");
            // Reload current memory to reflect any changes
            this.loadExistingMemory();
          }
          break;
      }

      sendResponse({ success: true });
    });
  }

  resetCardForm() {
    const noteInput = document.getElementById("lnms-note-input");
    if (noteInput) {
      noteInput.value = "";
    }

    // Clear selected tags
    document.querySelectorAll(".lnms-quick-tag").forEach((tag) => {
      tag.classList.remove("selected");
    });
    this.selectedTags.clear();
  }

  hideDeleteButton() {
    const deleteBtn = document.getElementById("lnms-delete-btn");
    if (deleteBtn) {
      deleteBtn.style.display = "none";
    }
  }

  updateCardWithMemory(memory) {
    const noteInput = document.getElementById("lnms-note-input");
    if (noteInput && noteInput.value !== memory.note) {
      noteInput.value = memory.note || "";
      this.updateQuickTagSelection();

      // Show delete button if memory has content
      const deleteBtn = document.getElementById("lnms-delete-btn");
      if (deleteBtn) {
        deleteBtn.style.display = memory.note ? "block" : "none";
      }
    }
  }

  checkProfilePage() {
    const url = window.location.href;
    const profilePattern =
      /^https:\/\/[^.]*\.?linkedin\.com\/in\/[^\/]+\/?(\?.*)?$/;
    const isProfile =
      profilePattern.test(url) &&
      !url.includes("/detail/") &&
      !url.includes("/overlay/") &&
      !url.includes("/edit/");

    this.isLinkedInProfile = isProfile;
    console.log("Profile page check:", url, "->", isProfile);
  }

  extractProfileData() {
    const mainContent =
      document.querySelector("main") ||
      document.querySelector(".scaffold-layout__main");
    if (!mainContent) {
      console.log("Main content not loaded yet");
      return false;
    }

    let name = "";
    let title = "";
    let company = "";
    let location = "";
    let education = "";
    let bio = "";

    try {
      // Enhanced name extraction
      const nameSelectors = [
        "h1.text-heading-xlarge",
        ".pv-text-details__left-panel h1",
        ".ph5.pb5 h1",
        "[data-generated-suggestion-target] h1",
        ".pv-top-card--list h1",
        "h1[data-generated-suggestion-target]",
        ".pv-top-card .pv-top-card__name",
        ".pv-top-card--photo h1",
        "section.pv-top-card h1",
      ];

      for (const selector of nameSelectors) {
        const element = document.querySelector(selector);
        const text = element?.textContent?.trim();
        if (text && text.length > 0 && text !== "LinkedIn Member") {
          name = text;
          console.log("Found name with selector:", selector, "->", name);
          break;
        }
      }

      // Enhanced title extraction
      const titleSelectors = [
        ".text-body-medium.break-words",
        ".pv-text-details__left-panel .text-body-medium",
        ".ph5 .text-body-medium",
        ".pv-top-card--list .text-body-medium",
        ".pv-top-card .pv-top-card__headline",
        ".pv-top-card--photo .text-body-medium",
      ];

      for (const selector of titleSelectors) {
        const element = document.querySelector(selector);
        const text = element?.textContent?.trim();
        if (
          text &&
          !text.includes("connections") &&
          !text.includes("followers") &&
          !text.includes("Contact info") &&
          text.length > 3
        ) {
          title = text;
          console.log("Found title with selector:", selector, "->", title);
          break;
        }
      }

      // Enhanced company extraction from title
      if (title) {
        // Common patterns for company extraction
        const companyPatterns = [
          / at (.+?)(?:\s\||$)/i,
          / @ (.+?)(?:\s\||$)/i,
          /\| (.+?)$/i,
        ];

        for (const pattern of companyPatterns) {
          const match = title.match(pattern);
          if (match && match[1]) {
            company = match[1].trim();
            // Clean up title to remove company info
            title = title.replace(pattern, "").trim();
            break;
          }
        }
      }

      // Location extraction
      const locationSelectors = [
        ".pv-text-details__left-panel .text-body-small:not(.break-words)",
        ".pv-top-card--list-bullet .text-body-small",
        ".pv-top-card .pv-top-card__location",
      ];

      for (const selector of locationSelectors) {
        const element = document.querySelector(selector);
        const text = element?.textContent?.trim();
        if (text && (text.includes(",") || text.match(/^[A-Za-z\s]+$/))) {
          location = text;
          break;
        }
      }

      // Enhanced education extraction
      const experienceSection =
        document.querySelector('[data-section="educationsDetails"]') ||
        document.querySelector(".pv-profile-section.education") ||
        document.querySelector('[id*="education"]');

      if (experienceSection) {
        const schoolElements = experienceSection.querySelectorAll(
          ".pv-entity__school-name, .t-16.t-black.t-bold"
        );
        if (schoolElements.length > 0) {
          education = schoolElements[0].textContent.trim();
        }
      }
    } catch (error) {
      console.error("Error extracting profile data:", error);
      return false;
    }

    // Validate extracted data
    if (
      !name ||
      name === "LinkedIn User" ||
      name === "LinkedIn Member" ||
      name.length < 2
    ) {
      console.log("Invalid or missing name:", name);
      return false;
    }

    this.profileData = {
      url: window.location.href.split("?")[0],
      name: name,
      title: title || "",
      company: company || "",
      location: location || "",
      education: education || "",
      bio: bio || "",
      extractedAt: Date.now(),
    };

    console.log("Successfully extracted profile data:", this.profileData);
    return true;
  }

  createMemoryCard() {
    this.cleanup();

    const card = document.createElement("div");
    card.id = "lnms-memory-card";
    card.innerHTML = this.getCardHTML();

    const fab = document.createElement("button");
    fab.id = "lnms-memory-fab";
    fab.innerHTML = `<img src="${chrome.runtime.getURL(
      "icons/penguin.png"
    )}" alt="Add Memory" style="width: 32px; height: 32px;">`;
    fab.title = "Add Memory Note";

    document.body.appendChild(card);
    document.body.appendChild(fab);

    this.setupEventListeners(card, fab);
    this.setupDraggable(card, fab);
    this.showCard();
  }

  getCardHTML() {
    const tagIcons = {
      important: "⭐",
      friend: "👥",
      alumni: "🎓",
      event: "📅",
      conference: "🎤",
    };

    const quickTagsHTML = this.quickTags
      .map(
        (tag) =>
          `<span class="lnms-quick-tag" data-tag="${tag}">${tagIcons[tag]} ${tag}</span>`
      )
      .join("");

    return `
      <div class="lnms-card-header" id="lnms-drag-handle">
        <h3 class="lnms-card-title">
          <img src="${chrome.runtime.getURL(
            "icons/penguin.png"
          )}" alt="Memory Card" style="width: 28px; height: 28px; vertical-align: middle;">
        </h3>
        <div class="lnms-controls">
          <button class="lnms-control-btn lnms-delete-btn" id="lnms-delete-btn" title="Delete Memory" style="display: none;">🗑️</button>
          <button class="lnms-control-btn" id="lnms-minimize" title="Minimize">−</button>
          <button class="lnms-control-btn" id="lnms-close" title="Close">×</button>
        </div>
      </div>
      <div class="lnms-card-body">
        <div class="lnms-profile-info">
          <div class="lnms-profile-name">${this.escapeHTML(
            this.profileData.name
          )}</div>
          <div class="lnms-profile-details">${this.escapeHTML(
            [
              this.profileData.title,
              this.profileData.company,
              this.profileData.education,
            ]
              .filter((item) => item)
              .join(" • ")
          )}</div>
        </div>
        
        <div class="lnms-tags-section">
          <div class="lnms-quick-tags">
            ${quickTagsHTML}
          </div>
        </div>
        
        <textarea 
          class="lnms-textarea" 
          id="lnms-note-input"
          placeholder="Type your memory here..."
          rows="4"
        ></textarea>
        
        <div class="lnms-note-hint">
          💡 Use #tags to organize memories
        </div>
      </div>
    `;
  }

  setupEventListeners(card, fab) {
    document
      .getElementById("lnms-minimize")
      ?.addEventListener("click", () => this.minimizeCard());
    document
      .getElementById("lnms-close")
      ?.addEventListener("click", () => this.hideCard());
    fab.addEventListener("click", () => this.showCard());
    document
      .getElementById("lnms-delete-btn")
      ?.addEventListener("click", () => this.deleteMemory());

    // Quick tags
    document.querySelectorAll(".lnms-quick-tag").forEach((tag) => {
      tag.addEventListener("click", () => this.toggleQuickTag(tag));
    });

    // Auto-save with improved debouncing
    const noteInput = document.getElementById("lnms-note-input");
    if (noteInput) {
      noteInput.addEventListener("input", () => {
        this.autoSave();
      });

      noteInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          this.hideCard();
        }
      });
    }
  }

  setupDraggable(card, fab) {
    const dragHandle = document.getElementById("lnms-drag-handle");

    if (dragHandle) {
      dragHandle.style.cursor = "move";

      dragHandle.addEventListener("mousedown", (e) => {
        if (e.target.closest(".lnms-control-btn")) return;

        this.isDragging = true;
        const rect = card.getBoundingClientRect();
        this.dragOffset.x = e.clientX - rect.left;
        this.dragOffset.y = e.clientY - rect.top;

        card.style.transition = "none";
        document.addEventListener("mousemove", this.handleCardDrag);
        document.addEventListener("mouseup", this.handleCardDragEnd);
        e.preventDefault();
      });
    }

    fab.addEventListener("mousedown", (e) => {
      this.isDragging = true;
      const rect = fab.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;

      fab.style.transition = "none";
      document.addEventListener("mousemove", this.handleFabDrag);
      document.addEventListener("mouseup", this.handleFabDragEnd);
      e.preventDefault();
    });

    this.handleCardDrag = this.handleCardDrag.bind(this);
    this.handleCardDragEnd = this.handleCardDragEnd.bind(this);
    this.handleFabDrag = this.handleFabDrag.bind(this);
    this.handleFabDragEnd = this.handleFabDragEnd.bind(this);
  }

  handleCardDrag(e) {
    if (!this.isDragging) return;

    const card = document.getElementById("lnms-memory-card");
    if (card) {
      const x = Math.max(
        0,
        Math.min(
          window.innerWidth - card.offsetWidth,
          e.clientX - this.dragOffset.x
        )
      );
      const y = Math.max(
        0,
        Math.min(
          window.innerHeight - card.offsetHeight,
          e.clientY - this.dragOffset.y
        )
      );

      card.style.left = x + "px";
      card.style.top = y + "px";
      card.style.right = "auto";
      card.style.bottom = "auto";
    }
  }

  handleCardDragEnd() {
    this.isDragging = false;
    const card = document.getElementById("lnms-memory-card");
    if (card) {
      card.style.transition = "";
    }
    document.removeEventListener("mousemove", this.handleCardDrag);
    document.removeEventListener("mouseup", this.handleCardDragEnd);
  }

  handleFabDrag(e) {
    if (!this.isDragging) return;

    const fab = document.getElementById("lnms-memory-fab");
    if (fab) {
      const x = Math.max(
        0,
        Math.min(
          window.innerWidth - fab.offsetWidth,
          e.clientX - this.dragOffset.x
        )
      );
      const y = Math.max(
        0,
        Math.min(
          window.innerHeight - fab.offsetHeight,
          e.clientY - this.dragOffset.y
        )
      );

      fab.style.left = x + "px";
      fab.style.top = y + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";
    }
  }

  handleFabDragEnd() {
    this.isDragging = false;
    const fab = document.getElementById("lnms-memory-fab");
    if (fab) {
      fab.style.transition = "";
    }
    document.removeEventListener("mousemove", this.handleFabDrag);
    document.removeEventListener("mouseup", this.handleFabDragEnd);
  }

  toggleQuickTag(tagElement) {
    const tag = tagElement.dataset.tag;
    const noteInput = document.getElementById("lnms-note-input");
    if (!noteInput) return;

    const tagText = `#${tag.toLowerCase()}`;

    if (tagElement.classList.contains("selected")) {
      tagElement.classList.remove("selected");
      this.selectedTags.delete(tag);

      const currentNote = noteInput.value;
      noteInput.value = currentNote
        .replace(new RegExp(`\\s*${tagText}\\b`, "gi"), "")
        .trim();
    } else {
      tagElement.classList.add("selected");
      this.selectedTags.add(tag);

      const currentNote = noteInput.value;
      if (!currentNote.toLowerCase().includes(tagText)) {
        noteInput.value = currentNote + (currentNote ? " " : "") + tagText;
      }
    }

    this.autoSave();
    noteInput.focus();
  }

  // ===== FIXED: Enhanced Memory Loading =====
  async loadExistingMemory() {
    const storageKey = this.getStorageKey();

    // ✅ Wait for any ongoing sync to finish
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      console.log("🔍 Loading existing memory for:", this.profileData.name);

      const result = await chrome.storage.local.get(storageKey);
      this.currentMemory = result[storageKey] || null;

      if (this.currentMemory) {
        console.log(
          "📝 Found existing memory:",
          this.currentMemory.note?.substring(0, 50) + "..."
        );

        const noteInput = document.getElementById("lnms-note-input");
        if (noteInput) {
          noteInput.value = this.currentMemory.note || "";
        }

        this.updateQuickTagSelection();

        const deleteBtn = document.getElementById("lnms-delete-btn");
        if (deleteBtn) {
          deleteBtn.style.display = "block";
        }

        // Update profile data with any additional info from stored memory
        this.mergeProfileDataWithStored(this.currentMemory);
        // NEW: Auto-update profile data if it has changed
        await this.updateProfileDataIfChanged();
      } else {
        console.log("📝 No existing memory found for this profile");

        // Hide delete button
        const deleteBtn = document.getElementById("lnms-delete-btn");
        if (deleteBtn) {
          deleteBtn.style.display = "none";
        }
      }
    } catch (error) {
      console.error("Error loading existing memory:", error);
    }
  }

  // NEW: Merge profile data to preserve complete information
  mergeProfileDataWithStored(storedMemory) {
    if (!storedMemory) return;

    // Preserve extracted data but fill in gaps from stored memory
    this.profileData = {
      ...this.profileData,
      // Keep newly extracted data but fill gaps with stored data
      title: this.profileData.title || storedMemory.title || "",
      company: this.profileData.company || storedMemory.company || "",
      location: this.profileData.location || storedMemory.location || "",
      education: this.profileData.education || storedMemory.education || "",
      bio: this.profileData.bio || storedMemory.bio || "",
    };

    console.log("🔗 Merged profile data:", this.profileData);
  }

  updateQuickTagSelection() {
    const noteInput = document.getElementById("lnms-note-input");
    if (!noteInput) return;

    const noteText = noteInput.value.toLowerCase();

    document.querySelectorAll(".lnms-quick-tag").forEach((tag) => {
      const tagText = `#${tag.dataset.tag.toLowerCase()}`;
      if (noteText.includes(tagText)) {
        tag.classList.add("selected");
        this.selectedTags.add(tag.dataset.tag);
      } else {
        tag.classList.remove("selected");
        this.selectedTags.delete(tag.dataset.tag);
      }
    });
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

  autoSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      await this.saveMemory();
    }, 250);
  }

  // ===== FIXED: Enhanced Save Memory =====
  async saveMemory() {
    const noteInput = document.getElementById("lnms-note-input");
    if (!noteInput) return;

    const note = noteInput.value.trim();

    // ✅ Preserve existing data, update with latest
    const memory = {
      name: this.profileData.name,
      title: this.currentMemory?.title || this.profileData.title || "",
      company: this.currentMemory?.company || this.profileData.company || "",
      location: this.currentMemory?.location || this.profileData.location || "",
      education:
        this.currentMemory?.education || this.profileData.education || "",
      bio: this.currentMemory?.bio || this.profileData.bio || "",
      url: this.profileData.url,

      note: note,
      tags: this.extractTagsFromNote(note),

      updatedAt: Date.now(),
      createdAt: this.currentMemory?.createdAt || Date.now(),
    };

    const storageKey = this.getStorageKey();

    try {
      if (note) {
        // Save memory with complete profile data
        await chrome.storage.local.set({ [storageKey]: memory });
        this.currentMemory = memory;

        const deleteBtn = document.getElementById("lnms-delete-btn");
        if (deleteBtn) {
          deleteBtn.style.display = "block";
        }

        console.log(
          "💾 Saved complete memory:",
          memory.name,
          "->",
          note.substring(0, 50) + "..."
        );

        // Notify popup about the update
        chrome.runtime
          .sendMessage({
            type: "memoryUpdated",
            url: this.profileData.url,
            memory: memory,
          })
          .catch(() => {
            // Popup might be closed, ignore error
          });
      } else {
        // Remove memory if note is empty
        await chrome.storage.local.remove(storageKey);
        this.currentMemory = null;

        const deleteBtn = document.getElementById("lnms-delete-btn");
        if (deleteBtn) {
          deleteBtn.style.display = "none";
        }

        console.log("🗑️ Removed empty memory for:", this.profileData.name);
      }
    } catch (error) {
      console.error("Error saving memory:", error);
    }
  }
  // NEW: Auto-update profile data when visiting profiles
  async updateProfileDataIfChanged() {
    if (!this.currentMemory) return;

    const hasProfileDataChanged =
      this.profileData.title !== this.currentMemory.title ||
      this.profileData.company !== this.currentMemory.company ||
      this.profileData.location !== this.currentMemory.location ||
      this.profileData.education !== this.currentMemory.education;

    if (hasProfileDataChanged) {
      console.log("🔄 Profile data changed, updating stored memory");

      // Update the stored memory with new profile data
      const updatedMemory = {
        ...this.currentMemory,
        title: this.profileData.title || this.currentMemory.title,
        company: this.profileData.company || this.currentMemory.company,
        location: this.profileData.location || this.currentMemory.location,
        education: this.profileData.education || this.currentMemory.education,
        bio: this.profileData.bio || this.currentMemory.bio,
        updatedAt: Date.now(),
      };

      const storageKey = this.getStorageKey();
      await chrome.storage.local.set({ [storageKey]: updatedMemory });
      this.currentMemory = updatedMemory;

      // Trigger background sync if connected to Google Drive
      chrome.runtime
        .sendMessage({
          type: "memoryUpdated",
          url: this.profileData.url,
          memory: updatedMemory,
        })
        .catch(() => {});
    }
  }

  async deleteMemory() {
    if (!this.currentMemory) return;

    const storageKey = this.getStorageKey();

    try {
      await chrome.storage.local.remove(storageKey);
      this.currentMemory = null;

      // Reset the form
      this.resetCardForm();
      this.hideDeleteButton();

      console.log("🗑️ Deleted memory for:", this.profileData.name);

      // Notify popup about the deletion
      chrome.runtime
        .sendMessage({
          type: "memoryDeleted",
          url: this.profileData.url,
        })
        .catch(() => {
          // Popup might be closed, ignore error
        });
    } catch (error) {
      console.error("Error deleting memory:", error);
    }
  }

  getStorageKey() {
    const cleanUrl = this.profileData.url.replace(/\/$/, "");
    return `lnms_${btoa(cleanUrl).replace(/[^a-zA-Z0-9]/g, "")}`;
  }

  showCard() {
    const card = document.getElementById("lnms-memory-card");
    const fab = document.getElementById("lnms-memory-fab");

    if (card) card.classList.remove("hidden");
    if (fab) fab.classList.remove("show");

    setTimeout(() => {
      const noteInput = document.getElementById("lnms-note-input");
      if (noteInput) noteInput.focus();
    }, 100);
  }

  hideCard() {
    const card = document.getElementById("lnms-memory-card");
    const fab = document.getElementById("lnms-memory-fab");

    if (card) card.classList.add("hidden");
    if (fab) fab.classList.add("show");
  }

  minimizeCard() {
    this.hideCard();
  }

  escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== IMPROVED Navigation Observer =====
  observeNavigation() {
    let navigationTimeout = null;

    const handleNavigation = () => {
      const newUrl = window.location.href;

      if (newUrl !== this.currentUrl) {
        console.log("🧭 Navigation detected:", this.currentUrl, "->", newUrl);

        if (navigationTimeout) {
          clearTimeout(navigationTimeout);
        }

        // Debounce navigation handling
        navigationTimeout = setTimeout(() => {
          this.cleanup();
          this.isInitialized = false;
          this.setup();
        }, 800);
      }
    };

    // URL monitoring for profile switches
    let lastUrl = window.location.href;
    setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        handleNavigation();
      }
    }, 1000);

    // Mutation observer for dynamic content changes
    this.navigationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          const addedNodes = Array.from(mutation.addedNodes);
          if (
            addedNodes.some(
              (node) =>
                node.nodeType === 1 &&
                ((node.matches && node.matches("title")) ||
                  (node.querySelector && node.querySelector("title")))
            )
          ) {
            handleNavigation();
            break;
          }
        }
      }
    });

    this.navigationObserver.observe(document.head, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("popstate", handleNavigation);
  }

  cleanup() {
    const card = document.getElementById("lnms-memory-card");
    const fab = document.getElementById("lnms-memory-fab");

    if (card) card.remove();
    if (fab) fab.remove();

    // Clean up drag event listeners
    document.removeEventListener("mousemove", this.handleCardDrag);
    document.removeEventListener("mouseup", this.handleCardDragEnd);
    document.removeEventListener("mousemove", this.handleFabDrag);
    document.removeEventListener("mouseup", this.handleFabDragEnd);

    this.selectedTags.clear();
    this.currentMemory = null;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    if (this.extractionTimeout) {
      clearTimeout(this.extractionTimeout);
      this.extractionTimeout = null;
    }

    this.dataExtractionAttempts = 0;
  }
}

// ===== FIXED: Better Initialization =====
if (
  typeof window !== "undefined" &&
  window.location.href.includes("linkedin.com")
) {
  // Clean up any existing instance
  if (window.lnmsInstance) {
    window.lnmsInstance.cleanup();
  }

  // Create new instance
  window.lnmsInstance = new LinkedInMemoryCard();
}
