const categoryContainer = document.getElementById("categoryContainer");
const favoriteContainer = document.getElementById("favoriteContainer");
const editFavoritesBtn = document.getElementById("editFavoritesBtn");
const addCategoryInlineBtn = document.getElementById("addCategoryInlineBtn");
const favEditActions = document.getElementById("favEditActions");
const favSiteModal = document.getElementById("favSiteModal");
const favSiteModalTitle = document.getElementById("favSiteModalTitle");
const favSiteNameInput = document.getElementById("favSiteNameInput");
const favSiteUrlInput = document.getElementById("favSiteUrlInput");
const favSiteModalCatId = document.getElementById("favSiteModalCatId");
const favSiteModalEditId = document.getElementById("favSiteModalEditId");
const favSiteModalSave = document.getElementById("favSiteModalSave");
const favSiteModalCancel = document.getElementById("favSiteModalCancel");
const linkPreview = document.getElementById("linkPreview");

const categoryTemplate = document.getElementById("categoryTemplate");
const tabItemTemplate = document.getElementById("tabItemTemplate");
const favoriteCategoryTemplate = document.getElementById("favoriteCategoryTemplate");
const favoriteSiteTemplate = document.getElementById("favoriteSiteTemplate");

const STATE_KEY_PREFIX = "tab-organizer-mvp:";
const FAV_SITES_KEY = "favoriteSites";
const FAV_CATS_KEY = "favoriteCategories";
const FAVICON_CACHE_KEY = "faviconCache";
const UNCATEGORIZED_NAME_KEY = "uncategorizedName";

let faviconCache = {};

const DEFAULT_FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#e8eaed"/><text x="16" y="22" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#5f6368">W</text></svg>'
)}`;

const DEFAULT_QUICK_LINKS = [
  { title: "豆包", url: "https://www.doubao.com/" },
  { title: "抖音", url: "https://www.douyin.com/user/self?from_tab_name=main&showTab=post" },
  { title: "DeepSeek", url: "https://www.deepseek.com/" },
  { title: "抖店", url: "https://fxg.jinritemai.com/login/common?channel=zhaoshang" }
];

const state = {
  organizerTabId: null,
  windowId: null,
  categories: [],
  dragging: null
};

const favoriteState = {
  sites: [],
  categories: [],
  dragging: null,
  editMode: false
};

let uncategorizedName = "未分类";

const linkSummaryCache = new Map();
let activePreviewUrl = "";

function buildCreateOptions(url = "", active = true) {
  const options = {
    windowId: state.windowId,
    active
  };
  if (url) {
    options.url = url;
  }
  if (state.organizerTabId) {
    options.openerTabId = state.organizerTabId;
  }
  return options;
}

async function openUrlInNewTab(url, active = true) {
  if (!url) {
    return;
  }
  await chrome.tabs.create(buildCreateOptions(url, active));
}

function truncateText(text, maxLength = 220) {
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function getDomainLabel(url) {
  try {
    return new URL(url).hostname || "网页摘要";
  } catch (_error) {
    return "网页摘要";
  }
}

function getPreviewNodes() {
  if (!linkPreview) {
    return null;
  }
  return {
    domain: linkPreview.querySelector(".link-preview-domain"),
    title: linkPreview.querySelector(".link-preview-title"),
    summary: linkPreview.querySelector(".link-preview-summary"),
    url: linkPreview.querySelector(".link-preview-url")
  };
}

function movePreview(event) {
  if (!linkPreview || linkPreview.hidden) {
    return;
  }
  const offset = 18;
  const previewWidth = Math.min(360, window.innerWidth - 24);
  const previewHeight = linkPreview.offsetHeight || 140;
  const maxLeft = Math.max(12, window.innerWidth - previewWidth - 12);
  const maxTop = Math.max(12, window.innerHeight - previewHeight - 12);
  const left = Math.min(event.clientX + offset, maxLeft);
  const top = Math.min(event.clientY + offset, maxTop);
  linkPreview.style.left = `${left}px`;
  linkPreview.style.top = `${top}px`;
}

function showPreviewSkeleton(event, title, url) {
  const nodes = getPreviewNodes();
  if (!linkPreview || !nodes) {
    return;
  }
  nodes.domain.textContent = getDomainLabel(url);
  nodes.title.textContent = title || "正在读取页面信息";
  nodes.summary.textContent = "正在加载网页摘要...";
  nodes.url.textContent = url || "";
  linkPreview.hidden = false;
  movePreview(event);
}

function hidePreview() {
  activePreviewUrl = "";
  if (!linkPreview) {
    return;
  }
  linkPreview.hidden = true;
}

function extractSummaryFromDocument(doc) {
  const metaSelectors = [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]'
  ];
  for (const selector of metaSelectors) {
    const content = doc.querySelector(selector)?.getAttribute("content") || "";
    const summary = truncateText(content, 220);
    if (summary) {
      return summary;
    }
  }

  const paragraphCandidates = Array.from(doc.querySelectorAll("article p, main p, p"))
    .map((node) => truncateText(node.textContent || "", 220))
    .filter((text) => text.length >= 30);
  if (paragraphCandidates.length > 0) {
    return paragraphCandidates[0];
  }
  return "暂时无法提取网页摘要。";
}

async function fetchLinkSummary(url) {
  if (!isHttpLikeUrl(url)) {
    return {
      title: "当前链接不支持摘要预览",
      summary: "仅支持 http 或 https 页面摘要。",
      url
    };
  }
  if (!linkSummaryCache.has(url)) {
    linkSummaryCache.set(
      url,
      (async () => {
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const title = truncateText(doc.title || "", 120);
          const summary = extractSummaryFromDocument(doc);
          return { title, summary, url };
        } catch (_error) {
          return {
            title: "",
            summary: "该网站限制了内容读取，当前仅显示链接信息。",
            url
          };
        }
      })()
    );
  }
  return linkSummaryCache.get(url);
}

async function showLinkPreview(event, title, url) {
  if (!url) {
    return;
  }
  activePreviewUrl = url;
  showPreviewSkeleton(event, title, url);
  const previewData = await fetchLinkSummary(url);
  if (activePreviewUrl !== url) {
    return;
  }
  const nodes = getPreviewNodes();
  if (!nodes) {
    return;
  }
  nodes.domain.textContent = getDomainLabel(url);
  nodes.title.textContent = previewData.title || title || "未命名网页";
  nodes.summary.textContent = previewData.summary || "暂时无法提取网页摘要。";
  nodes.url.textContent = url;
}

function attachPreviewHandlers(node, title, url) {
  if (!node) {
    return;
  }
  node.addEventListener("mouseenter", (event) => {
    void showLinkPreview(event, title, url);
  });
  node.addEventListener("mousemove", movePreview);
  node.addEventListener("mouseleave", hidePreview);
  node.addEventListener("blur", hidePreview);
}

async function getCurrentTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab || null;
  } catch (_) {
    return null;
  }
}

function getRootDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const tld = parts.slice(-2).join(".");
  const dualTlds = ["com.cn", "co.uk", "co.jp", "com.hk", "com.au", "org.cn", "net.cn"];
  if (dualTlds.includes(tld) && parts.length > 2) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function extractDomain(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return getRootDomain(parsed.hostname);
    }
    return "其他";
  } catch (_error) {
    return "其他";
  }
}

function newCategoryId() {
  return `cat_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function newFavId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function isHttpLikeUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function normalizeFaviconUrl(url) {
  if (isHttpLikeUrl(url)) return url;
  if (typeof url === "string" && url.startsWith("chrome://favicon/")) return url;
  return "";
}

async function loadFaviconCache() {
  const result = await chrome.storage.local.get([FAVICON_CACHE_KEY]);
  faviconCache = result[FAVICON_CACHE_KEY] || {};
}

async function saveFaviconCache() {
  await chrome.storage.local.set({ [FAVICON_CACHE_KEY]: faviconCache });
}

function cacheFaviconUrl(pageUrl, faviconUrl) {
  const normalized = normalizeFaviconUrl(faviconUrl);
  if (!normalized) return;
  try {
    const hostname = new URL(pageUrl).hostname;
    if (!faviconCache[hostname]) {
      faviconCache[hostname] = normalized;
      saveFaviconCache();
    }
  } catch (_) {}
}

function resolveFaviconSrc(pageUrl) {
  if (!pageUrl) return DEFAULT_FAVICON;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (faviconCache[parsed.hostname]) {
        return faviconCache[parsed.hostname];
      }
      return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
    }
  } catch (_) {}
  return DEFAULT_FAVICON;
}

function getFaviconUrl(url, fallbackUrl = "") {
  const safeFallback = normalizeFaviconUrl(fallbackUrl);
  if (safeFallback) return safeFallback;
  if (url) return resolveFaviconSrc(url);
  return DEFAULT_FAVICON;
}

function applyFavicon(imgNode, url, fallbackUrl = "") {
  const src = getFaviconUrl(url, fallbackUrl);
  imgNode.src = src || DEFAULT_FAVICON;
  imgNode.addEventListener(
    "error",
    () => {
      imgNode.src = DEFAULT_FAVICON;
    },
    { once: true }
  );
  imgNode.addEventListener(
    "load",
    () => {
      if (src && src.includes("google.com/s2/favicons")) {
        try {
          const hostname = new URL(url).hostname;
          if (!faviconCache[hostname]) {
            faviconCache[hostname] = src;
            saveFaviconCache();
          }
        } catch (_) {}
      }
    },
    { once: true }
  );
}

function getStateKey() {
  return `${STATE_KEY_PREFIX}${state.windowId || "unknown"}`;
}

async function saveTempState() {
  if (!state.windowId) {
    return;
  }
  const payload = {
    windowId: state.windowId,
    categories: state.categories
  };
  await chrome.storage.local.set({ [getStateKey()]: payload });
}

async function clearTempState() {
  if (!state.windowId) {
    return;
  }
  await chrome.storage.local.remove(getStateKey());
}

function buildInitialCategories(tabs) {
  const map = new Map();
  const sortedTabs = [...tabs].sort((a, b) => a.index - b.index);
  for (const tab of sortedTabs) {
    const domain = extractDomain(tab.url || "");
    if (!map.has(domain)) {
      map.set(domain, {
        id: newCategoryId(),
        name: domain,
        custom: false,
        tabs: []
      });
    }
    map.get(domain).tabs.push({
      id: tab.id,
      title: tab.title || "(无标题)",
      url: tab.url || "",
      faviconUrl: normalizeFaviconUrl(tab.favIconUrl || ""),
      originalIndex: tab.index
    });
  }
  return Array.from(map.values());
}

function removeTabFromCategory(category, tabId) {
  const index = category.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return null;
  }
  const [tab] = category.tabs.splice(index, 1);
  return tab;
}

function findTabLocation(tabId) {
  for (const category of state.categories) {
    const tab = category.tabs.find((item) => item.id === tabId);
    if (tab) {
      return { category, tab };
    }
  }
  return null;
}

function onDragStart(event, tabId, fromCategoryId) {
  state.dragging = { tabId, fromCategoryId };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(tabId));
  event.currentTarget.classList.add("dragging");
}

function onDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  state.dragging = null;
  for (const el of document.querySelectorAll(".category.drag-over")) {
    el.classList.remove("drag-over");
  }
}

function render() {
  categoryContainer.innerHTML = "";

  let catIndex = 0;
  for (const category of state.categories) {
    const section = categoryTemplate.content.firstElementChild.cloneNode(true);
    section.classList.add("card-spotlight", "reveal-item");
    section.style.setProperty("--reveal-index", catIndex);
    const categoryFavicon = section.querySelector(".category-favicon");
    const titleEl = section.querySelector(".category-title");
    const tabListEl = section.querySelector(".tab-list");
    const deleteCategoryBtn = section.querySelector(".delete-category-btn");
    const closeAllBtn = section.querySelector(".close-all-btn");
    const sampleTab = category.tabs[0] || null;

    titleEl.textContent = `${category.name} (${category.tabs.length})`;
    titleEl.title = "双击编辑分类名";
    applyFavicon(categoryFavicon, sampleTab?.url || "", sampleTab?.faviconUrl || "");

    titleEl.addEventListener("dblclick", () => {
      startInlineEdit(titleEl, category.name, async (newName) => {
        const cat = state.categories.find((c) => c.id === category.id);
        if (cat && newName.trim()) {
          cat.name = newName.trim();
          await saveTempState();
          render();
        }
      });
    });

    if (category.custom && category.tabs.length === 0) {
      deleteCategoryBtn.style.display = "inline-block";
      deleteCategoryBtn.addEventListener("click", async () => {
        state.categories = state.categories.filter((item) => item.id !== category.id);
        await saveTempState();
        render();
      });
    } else {
      deleteCategoryBtn.style.display = "none";
    }

    closeAllBtn.addEventListener("click", async () => {
      const tabIds = category.tabs.map((tab) => tab.id);
      try {
        await chrome.tabs.remove(tabIds);
      } catch (_error) {
        // 部分标签可能已被关闭
      }
      await refreshCategories();
    });

    section.addEventListener("dragover", (event) => {
      event.preventDefault();
      section.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    section.addEventListener("dragleave", () => {
      section.classList.remove("drag-over");
    });
    section.addEventListener("drop", async (event) => {
      event.preventDefault();
      section.classList.remove("drag-over");
      if (!state.dragging) {
        return;
      }
      const { tabId, fromCategoryId } = state.dragging;
      if (fromCategoryId === category.id) {
        return;
      }
      const fromCategory = state.categories.find((item) => item.id === fromCategoryId);
      const toCategory = state.categories.find((item) => item.id === category.id);
      if (!fromCategory || !toCategory) {
        return;
      }
      const moved = removeTabFromCategory(fromCategory, tabId);
      if (!moved) {
        return;
      }
      toCategory.tabs.push(moved);
      await saveTempState();
      render();
    });

    let tabIndex = 0;
    for (const tab of category.tabs) {
      const tabItem = tabItemTemplate.content.firstElementChild.cloneNode(true);
      tabItem.classList.add("card-spotlight", "reveal-item");
      tabItem.style.setProperty("--reveal-index", tabIndex);
      const titleNode = tabItem.querySelector(".tab-title");
      const linkNode = tabItem.querySelector(".tab-link");
      const faviconNode = tabItem.querySelector(".tab-favicon");

      titleNode.textContent = tab.title;
      linkNode.textContent = tab.url;
      linkNode.href = tab.url || "about:blank";
      applyFavicon(faviconNode, tab.url, tab.faviconUrl || "");
      cacheFaviconUrl(tab.url, tab.faviconUrl || "");
      linkNode.addEventListener("click", async (event) => {
        event.preventDefault();
        if (!tab.url) {
          return;
        }
        await chrome.tabs.update(tab.id, { active: true });
      });
      attachPreviewHandlers(linkNode, tab.title, tab.url);

      const closeBtn = tabItem.querySelector(".tab-close-btn");
      closeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
          await chrome.tabs.remove(tab.id);
        } catch (_) {}
        await refreshCategories();
      });

      tabItem.addEventListener("dragstart", (event) => onDragStart(event, tab.id, category.id));
      tabItem.addEventListener("dragend", onDragEnd);

      tabListEl.appendChild(tabItem);
      tabIndex++;
    }

    categoryContainer.appendChild(section);
    catIndex++;
  }

  observeReveal(categoryContainer);
}

async function refreshCategories() {
  const tabs = await chrome.tabs.query({ windowId: state.windowId });
  const organizerTabId = state.organizerTabId;
  const candidateTabs = tabs.filter((item) => item.id !== organizerTabId);
  state.categories = buildInitialCategories(candidateTabs);
  await saveTempState();
  render();
}

// ========== Favorite Sites ==========

async function loadFavoriteData() {
  const result = await chrome.storage.local.get([FAV_SITES_KEY, FAV_CATS_KEY, UNCATEGORIZED_NAME_KEY]);
  favoriteState.sites = result[FAV_SITES_KEY] || [];
  favoriteState.categories = result[FAV_CATS_KEY] || [];
  uncategorizedName = result[UNCATEGORIZED_NAME_KEY] || "未分类";
}

async function saveFavoriteData() {
  await chrome.storage.local.set({
    [FAV_SITES_KEY]: favoriteState.sites,
    [FAV_CATS_KEY]: favoriteState.categories
  });
}

async function saveUncategorizedName(name) {
  uncategorizedName = name;
  await chrome.storage.local.set({ [UNCATEGORIZED_NAME_KEY]: name });
}

async function migrateDefaultQuickLinks() {
  const result = await chrome.storage.local.get([FAV_SITES_KEY, FAV_CATS_KEY]);
  const existingSites = result[FAV_SITES_KEY];
  if (existingSites && existingSites.length > 0) {
    return;
  }
  const defaultCatId = newFavId("favcat");
  const now = Date.now();
  favoriteState.categories = [{
    id: defaultCatId,
    name: "常用",
    order: 0,
    createdAt: now
  }];
  favoriteState.sites = DEFAULT_QUICK_LINKS.map((link, index) => ({
    id: newFavId("fav"),
    title: link.title,
    url: link.url,
    categoryId: defaultCatId,
    order: index,
    createdAt: now + index
  }));
  await saveFavoriteData();
}

function getFavCategoryName(categoryId) {
  const cat = favoriteState.categories.find((c) => c.id === categoryId);
  return cat ? cat.name : "未分类";
}

function renderFavorites() {
  favoriteContainer.innerHTML = "";

  const uncategorizedSites = favoriteState.sites
    .filter((s) => !s.categoryId)
    .sort((a, b) => a.order - b.order);

  let favIndex = 0;
  for (const cat of favoriteState.categories) {
    const catSites = favoriteState.sites
      .filter((s) => s.categoryId === cat.id)
      .sort((a, b) => a.order - b.order);
    renderFavoriteCategory(cat, catSites, favIndex);
    favIndex++;
  }

  if (uncategorizedSites.length > 0 || favoriteState.editMode) {
    renderFavoriteCategory({ id: null, name: uncategorizedName, order: 999 }, uncategorizedSites, favIndex);
  }

  if (favoriteState.editMode) {
    setupFavoriteDrag();
  }

  observeReveal(favoriteContainer);
}

function renderFavoriteCategory(cat, sites, catIndex = 0) {
  const catEl = favoriteCategoryTemplate.content.firstElementChild.cloneNode(true);
  catEl.classList.add("card-spotlight", "reveal-item");
  catEl.style.setProperty("--reveal-index", catIndex);
  const nameEl = catEl.querySelector(".fav-category-name");
  const countEl = catEl.querySelector(".fav-category-count");
  const siteListEl = catEl.querySelector(".fav-site-list");
  const deleteBtn = catEl.querySelector(".delete-fav-category-btn");
  const addSiteBtn = catEl.querySelector(".btn-add-site");
  catEl.dataset.categoryId = cat.id || "";
  nameEl.textContent = cat.name;
  nameEl.style.minWidth = "2em";
  countEl.textContent = `(${sites.length})`;

  const isEditMode = favoriteState.editMode;

  if (cat.id === null) {
    deleteBtn.style.display = "none";
  }

  // Toggle edit-mode-only elements
  for (const el of catEl.querySelectorAll(".edit-mode-only")) {
    el.style.display = isEditMode ? "" : "none";
  }
  addSiteBtn.style.display = isEditMode ? "" : "none";

  // Editing class for CSS hover styling
  if (isEditMode) {
    catEl.classList.add("editing");
  }

  // Single-click category name to edit (in edit mode only)
  nameEl.addEventListener("click", () => {
    if (!isEditMode) return;
    startInlineEdit(nameEl, cat.name, async (newName) => {
      if (!newName.trim()) return;
      if (cat.id === null) {
        await saveUncategorizedName(newName.trim());
      } else {
        const c = favoriteState.categories.find((c) => c.id === cat.id);
        if (c) {
          c.name = newName.trim();
          await saveFavoriteData();
        }
      }
      renderFavorites();
    });
  });

  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`删除分类"${cat.name}"？分类下的网站将移入"未分类"。`)) return;
    for (const site of favoriteState.sites) {
      if (site.categoryId === cat.id) {
        site.categoryId = null;
      }
    }
    favoriteState.categories = favoriteState.categories.filter((c) => c.id !== cat.id);
    await saveFavoriteData();
    renderFavorites();
  });

  addSiteBtn.addEventListener("click", () => {
    showAddSiteModal(cat.id);
  });

  let siteIndex = 0;
  for (const site of sites) {
    const siteEl = renderFavoriteSite(site, catEl, isEditMode, siteIndex);
    siteListEl.appendChild(siteEl);
    siteIndex++;
  }

  if (cat.id !== null && isEditMode) {
    catEl.addEventListener("dragstart", (e) => {
      if (e.target.closest(".fav-site-card")) return;
      favoriteState.dragging = { type: "category", categoryId: cat.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", cat.id);
      catEl.classList.add("cat-dragging");
    });

    catEl.addEventListener("dragend", () => {
      catEl.classList.remove("cat-dragging");
      if (favoriteState.dragging?.type === "category") {
        favoriteState.dragging = null;
      }
      for (const el of document.querySelectorAll(".fav-category.drag-over")) {
        el.classList.remove("drag-over");
      }
    });
  }

  favoriteContainer.appendChild(catEl);
}

function renderFavoriteSite(site, catEl, isEditMode = false, siteIndex = 0) {
  const siteEl = favoriteSiteTemplate.content.firstElementChild.cloneNode(true);
  siteEl.classList.add("card-spotlight", "reveal-item");
  siteEl.style.setProperty("--reveal-index", siteIndex);
  const faviconEl = siteEl.querySelector(".fav-site-favicon");
  const titleEl = siteEl.querySelector(".fav-site-title");
  const urlEl = siteEl.querySelector(".fav-site-url");
  const editBtn = siteEl.querySelector(".edit-fav-btn");
  const deleteBtn = siteEl.querySelector(".delete-fav-btn");
  const hoverActions = siteEl.querySelector(".fav-site-hover-actions");

  siteEl.dataset.siteId = site.id;
  siteEl.dataset.categoryId = site.categoryId || "";

  titleEl.textContent = site.title;
  urlEl.textContent = site.url;
  applyFavicon(faviconEl, site.url, site.faviconUrl || "");

  // In edit mode, always show actions; in normal mode, show on hover
  if (hoverActions) {
    hoverActions.classList.toggle("edit-mode-visible", isEditMode);
  }

  siteEl.addEventListener("click", async (e) => {
    if (e.target.closest(".fav-site-hover-actions")) return;
    await openUrlInNewTab(site.url, true);
  });

  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showEditSiteModal(site);
  });

  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`确定删除常用网站"${site.title}"？`)) return;
    favoriteState.sites = favoriteState.sites.filter((s) => s.id !== site.id);
    await saveFavoriteData();
    renderFavorites();
  });

  if (isEditMode) {
    siteEl.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      favoriteState.dragging = { type: "site", siteId: site.id, fromCategoryId: site.categoryId };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", site.id);
      siteEl.classList.add("dragging");
    });

    siteEl.addEventListener("dragend", () => {
      siteEl.classList.remove("dragging");
      favoriteState.dragging = null;
      for (const el of document.querySelectorAll(".fav-site-card.drag-over")) {
        el.classList.remove("drag-over");
      }
      for (const el of document.querySelectorAll(".fav-category.drag-over")) {
        el.classList.remove("drag-over");
      }
    });
  }

  return siteEl;
}

function setupFavoriteDrag() {
  const siteCards = document.querySelectorAll(".fav-site-card");
  const catEls = document.querySelectorAll(".fav-category");

  for (const card of siteCards) {
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (favoriteState.dragging?.type === "site" && favoriteState.dragging.siteId !== card.dataset.siteId) {
        e.stopPropagation();
        card.classList.add("drag-over");
        e.dataTransfer.dropEffect = "move";
      }
    });

    card.addEventListener("dragleave", (e) => {
      card.classList.remove("drag-over");
    });

    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("drag-over");
      if (!favoriteState.dragging || favoriteState.dragging.type !== "site") return;

      const { siteId } = favoriteState.dragging;
      const targetSiteId = card.dataset.siteId;
      const targetCategoryId = card.dataset.categoryId || null;

      if (siteId === targetSiteId) return;

      const dragged = favoriteState.sites.find((s) => s.id === siteId);
      if (!dragged) return;

      const targetIndex = favoriteState.sites.findIndex((s) => s.id === targetSiteId);
      dragged.categoryId = targetCategoryId;
      dragged.order = targetIndex;

      let order = 0;
      for (const site of favoriteState.sites) {
        site.order = order++;
      }
      await saveFavoriteData();
      renderFavorites();
    });
  }

  for (const catEl of catEls) {
    catEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!favoriteState.dragging) return;
      if (favoriteState.dragging.type === "site" && !e.target.closest(".fav-site-card")) {
        catEl.classList.add("drag-over");
        e.dataTransfer.dropEffect = "move";
      }
      if (favoriteState.dragging.type === "category" && favoriteState.dragging.categoryId !== catEl.dataset.categoryId) {
        catEl.classList.add("drag-over");
        e.dataTransfer.dropEffect = "move";
      }
    });

    catEl.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget || !catEl.contains(e.relatedTarget)) {
        catEl.classList.remove("drag-over");
      }
    });

    catEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      catEl.classList.remove("drag-over");
      if (!favoriteState.dragging) return;

      if (favoriteState.dragging.type === "site") {
        if (e.target.closest(".fav-site-card")) return;
        const { siteId } = favoriteState.dragging;
        const targetCatId = catEl.dataset.categoryId || null;

        const dragged = favoriteState.sites.find((s) => s.id === siteId);
        if (dragged) {
          dragged.categoryId = targetCatId;
          const maxOrder = favoriteState.sites
            .filter((s) => s.categoryId === targetCatId && s.id !== dragged.id)
            .reduce((max, s) => Math.max(max, s.order), -1);
          dragged.order = maxOrder + 1;
          await saveFavoriteData();
          renderFavorites();
        }
      }

      if (favoriteState.dragging.type === "category") {
        const { categoryId } = favoriteState.dragging;
        const targetCatId = catEl.dataset.categoryId;
        if (!categoryId || !targetCatId || categoryId === targetCatId) return;

        const draggedIdx = favoriteState.categories.findIndex((c) => c.id === categoryId);
        const targetIdx = favoriteState.categories.findIndex((c) => c.id === targetCatId);
        if (draggedIdx < 0 || targetIdx < 0) return;

        const [draggedCat] = favoriteState.categories.splice(draggedIdx, 1);
        const newTargetIdx = favoriteState.categories.findIndex((c) => c.id === targetCatId);
        favoriteState.categories.splice(newTargetIdx, 0, draggedCat);

        let order = 0;
        for (const cat of favoriteState.categories) {
          cat.order = order++;
        }
        await saveFavoriteData();
        renderFavorites();
      }
    });
  }
}

function startInlineEdit(el, currentValue, onSave) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit-input";
  input.value = currentValue;
  input.maxLength = 30;

  el.replaceWith(input);
  input.focus();
  input.select();

  let finishing = false;

  const finish = async (save) => {
    if (finishing) return;
    finishing = true;
    if (save && input.value.trim() && input.value.trim() !== currentValue) {
      await onSave(input.value.trim());
    } else {
      input.replaceWith(el);
    }
  };

  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
}

function showAddSiteModal(categoryId, prefillTitle = "", prefillUrl = "") {
  favSiteModalTitle.textContent = "添加网站";
  favSiteNameInput.value = prefillTitle;
  favSiteUrlInput.value = prefillUrl;
  favSiteModalCatId.value = categoryId || "";
  favSiteModalEditId.value = "";
  favSiteModal.hidden = false;
  favSiteUrlInput.focus();
}

function showEditSiteModal(site) {
  favSiteModalTitle.textContent = "编辑网站";
  favSiteNameInput.value = site.title;
  favSiteUrlInput.value = site.url;
  favSiteModalCatId.value = "";
  favSiteModalEditId.value = site.id;
  favSiteModal.hidden = false;
  favSiteNameInput.focus();
}

function hideFavModal() {
  favSiteModal.hidden = true;
  favSiteNameInput.value = "";
  favSiteUrlInput.value = "";
  favSiteModalCatId.value = "";
  favSiteModalEditId.value = "";
}

function isValidTitle(title) {
  if (!title || typeof title !== "string") return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  const invalidTitles = [
    "未命名网页", "无法获取网页摘要", "当前链接不支持摘要预览", "无效链接",
    "企业微信文档", "腾讯文档", "企业文档",
    "钉钉文档", "飞书文档",
    "Google Docs", "Notion"
  ];
  if (invalidTitles.includes(trimmed)) return false;
  return true;
}

function fetchTitleViaBackgroundTab(url) {
  return new Promise((resolve) => {
    let resolved = false;
    let completeFired = false;
    let lastTitle = "";
    let lastFavIconUrl = "";
    let debounceTimer = null;
    let initialWaitTimer = null;
    let debounceEnabled = false;
    let tabId = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (initialWaitTimer) clearTimeout(initialWaitTimer);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    };

    const done = (title, favIconUrl) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ title: title || "", favIconUrl: favIconUrl || "" });
    };

    const scheduleDone = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        done(lastTitle, lastFavIconUrl);
      }, 1500);
    };

    const listener = (tId, changeInfo, updatedTab) => {
      if (tId !== tabId) return;

      if (updatedTab.title && updatedTab.title !== lastTitle) {
        lastTitle = updatedTab.title;
        if (debounceEnabled) scheduleDone();
      }
      if (updatedTab.favIconUrl && updatedTab.favIconUrl !== lastFavIconUrl) {
        lastFavIconUrl = updatedTab.favIconUrl;
      }

      if (changeInfo.status === "complete") {
        completeFired = true;
        lastTitle = updatedTab.title || lastTitle;
        lastFavIconUrl = updatedTab.favIconUrl || lastFavIconUrl;
        initialWaitTimer = setTimeout(() => {
          debounceEnabled = true;
          scheduleDone();
        }, 1000);
      }
    };

    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab) {
        done("", "");
        return;
      }
      tabId = tab.id;
      chrome.tabs.onUpdated.addListener(listener);

      setTimeout(() => {
        done(lastTitle, lastFavIconUrl);
      }, 6000);
    });
  });
}

function resolveDomainName(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch (_) {
    return "未命名网站";
  }
}

async function findOpenTab(url) {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url) || null;
  } catch (_) {
    return null;
  }
}

favSiteModalSave.addEventListener("click", async () => {
  let title = favSiteNameInput.value.trim();
  const url = favSiteUrlInput.value.trim();
  const editId = favSiteModalEditId.value;

  if (!url) {
    alert("请填写网址。");
    return;
  }

  try {
    new URL(url);
  } catch (_) {
    alert("请输入有效的网址（以 http:// 或 https:// 开头）。");
    return;
  }

  let capturedFaviconUrl = "";

  if (!title) {
    const openTab = await findOpenTab(url);
    if (openTab && isValidTitle(openTab.title)) {
      title = openTab.title;
      capturedFaviconUrl = normalizeFaviconUrl(openTab.favIconUrl || "");
    } else {
      title = resolveDomainName(url);
    }
  }

  let savedSiteId = editId || null;

  if (editId) {
    const site = favoriteState.sites.find((s) => s.id === editId);
    if (site) {
      site.title = title;
      site.url = url;
      if (capturedFaviconUrl) {
        site.faviconUrl = capturedFaviconUrl;
      }
    }
  } else {
    savedSiteId = newFavId("fav");
    const categoryId = favSiteModalCatId.value || null;
    const maxOrder = favoriteState.sites
      .filter((s) => s.categoryId === categoryId)
      .reduce((max, s) => Math.max(max, s.order), -1);
    favoriteState.sites.push({
      id: savedSiteId,
      title,
      url,
      categoryId,
      order: maxOrder + 1,
      createdAt: Date.now(),
      faviconUrl: capturedFaviconUrl
    });
  }

  if (capturedFaviconUrl) {
    cacheFaviconUrl(url, capturedFaviconUrl);
  }

  await saveFavoriteData();
  hideFavModal();
  renderFavorites();

  if (!favSiteNameInput.value.trim()) {
    fetchAndUpdateSiteTitle(savedSiteId, url);
  }
});

async function fetchAndUpdateSiteTitle(siteId, url) {
  if (!isHttpLikeUrl(url)) return;
  try {
    const { title, favIconUrl } = await fetchTitleViaBackgroundTab(url);
    if (favIconUrl) {
      cacheFaviconUrl(url, favIconUrl);
      const site = favoriteState.sites.find((s) => s.id === siteId);
      if (site && !site.faviconUrl) {
        site.faviconUrl = normalizeFaviconUrl(favIconUrl);
      }
    }
    if (isValidTitle(title)) {
      const site = favoriteState.sites.find((s) => s.id === siteId);
      if (site && site.title === resolveDomainName(url)) {
        site.title = title;
        await saveFavoriteData();
        renderFavorites();
      }
    }
  } catch (_) {}
}

favSiteUrlInput.addEventListener("blur", async () => {
  const url = favSiteUrlInput.value.trim();
  const nameInput = favSiteNameInput;
  if (!url || nameInput.value.trim()) return;
  if (!isHttpLikeUrl(url)) return;
  nameInput.placeholder = "获取中...";
  try {
    const data = await fetchLinkSummary(url);
    if (data && isValidTitle(data.title) && !nameInput.value.trim()) {
      nameInput.value = data.title;
    }
  } catch (_) {}
  nameInput.placeholder = "留空则自动获取网页标题";
});

favSiteModalCancel.addEventListener("click", () => {
  hideFavModal();
});

favSiteModal.addEventListener("click", (e) => {
  if (e.target === favSiteModal) {
    hideFavModal();
  }
});

editFavoritesBtn.addEventListener("click", () => {
  favoriteState.editMode = !favoriteState.editMode;
  editFavoritesBtn.textContent = favoriteState.editMode ? "完成编辑" : "编辑分类";
  if (favoriteState.editMode) {
    favEditActions.hidden = false;
  } else {
    favEditActions.hidden = true;
  }
  renderFavorites();
});

addCategoryInlineBtn.addEventListener("click", async () => {
  const name = prompt("请输入分类名称：");
  if (!name || !name.trim()) return;
  const maxOrder = favoriteState.categories.reduce((max, c) => Math.max(max, c.order), -1);
  favoriteState.categories.push({
    id: newFavId("favcat"),
    name: name.trim(),
    order: maxOrder + 1,
    createdAt: Date.now()
  });
  await saveFavoriteData();
  renderFavorites();
});

// ========== Scroll Effects ==========

let revealObserver = null;

function setupScrollGradients() {
  const top = document.createElement("div");
  top.className = "scroll-gradient-top";
  top.style.opacity = "0";

  const bottom = document.createElement("div");
  bottom.className = "scroll-gradient-bottom";
  bottom.style.opacity = "1";

  document.body.appendChild(top);
  document.body.appendChild(bottom);

  const update = () => {
    const st = window.scrollY || document.documentElement.scrollTop;
    const sh = document.documentElement.scrollHeight;
    const ch = document.documentElement.clientHeight;
    top.style.opacity = Math.min(st / 60, 1);
    const dist = sh - (st + ch);
    bottom.style.opacity = sh <= ch ? 0 : Math.min(dist / 60, 1);
  };

  window.addEventListener("scroll", update, { passive: true });
  update();
}

function setupRevealObserver() {
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -30px 0px" }
  );
  document.querySelectorAll(".reveal-item").forEach((el) => revealObserver.observe(el));
}

function observeReveal(root) {
  if (!revealObserver) return;
  (root || document).querySelectorAll(".reveal-item:not(.revealed)").forEach((el) => revealObserver.observe(el));
}

function setupSpotlight() {
  document.addEventListener("mousemove", (e) => {
    const card = e.target.closest(".card-spotlight");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
    card.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
  });
}

// ========== Init ==========

async function init() {
  setupScrollGradients();
  setupRevealObserver();
  setupSpotlight();

  const [tab, currentWindow] = await Promise.all([
    getCurrentTab(),
    chrome.windows.getCurrent().catch(() => null)
  ]);
  state.organizerTabId = tab?.id || null;
  state.windowId = currentWindow?.id || null;

  if (!state.windowId) {
    const allWindows = await chrome.windows.getAll({ populate: false }).catch(() => []);
    const current = allWindows.find((w) => w.focused) || allWindows[0];
    state.windowId = current?.id || null;
  }

  if (state.windowId) {
    await refreshCategories();
  }

  await loadFavoriteData();
  await loadFaviconCache();
  await migrateDefaultQuickLinks();
  renderFavorites();

  if (state.windowId) {
    chrome.tabs.onCreated.addListener(async (newTab) => {
      if (newTab.windowId === state.windowId) {
        await refreshCategories();
      }
    });

    chrome.tabs.onRemoved.addListener(async (removedTabId, removeInfo) => {
      if (removeInfo.windowId === state.windowId && removedTabId !== state.organizerTabId) {
        await refreshCategories();
      }
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, updatedTab) => {
      if (updatedTab.windowId === state.windowId && tabId !== state.organizerTabId) {
        await refreshCategories();
      }
    });

    chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
      if (moveInfo.windowId === state.windowId) {
        await refreshCategories();
      }
    });
  }
}

init().catch((error) => {
  console.error("Failed to initialize organizer:", error);
  const errorDiv = document.createElement("div");
  errorDiv.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#ffffff;color:#202124;padding:24px 32px;border:1px solid #dadce0;border-radius:12px;max-width:480px;text-align:center;box-shadow:0 4px 12px rgba(60,64,67,0.15);z-index:9999;font-family:system-ui,sans-serif;";
  errorDiv.innerHTML = `<h3 style="margin:0 0 12px;color:#d93025;">加载失败</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.5;">插件页面初始化出错，请尝试：<br>1. 在 chrome://extensions/ 刷新插件<br>2. 关闭并重新打开此页面</p><p style="margin:0;font-size:12px;color:#9aa0a6;">错误: ${error?.message || "未知错误"}</p>`;
  document.body.appendChild(errorDiv);
});
