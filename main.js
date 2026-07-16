const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const WINDOW_STATE_FILE = "window-state.json";
const PET_SCALE_LIMITS = { min: 0.35, max: 1 };
const PET_ASPECT_RATIO = 384 / 416;
const PET_OPTIONS = [
  { id: "minji", label: "Minji" },
  { id: "hanni", label: "Hanni" },
  { id: "daniel", label: "Danielle" },
  { id: "haerin", label: "Haerin" },
  { id: "hyein", label: "Hyein" }
];
const PET_ID_SET = new Set(PET_OPTIONS.map((pet) => pet.id));

let tray = null;
let isQuitting = false;
let currentState = null;
const petWindows = new Map();
const dragSessions = new Map();
const closingPets = new Set();

function getPackagedIconPath() {
  return path.join(process.resourcesPath, process.platform === "darwin" ? "icon.icns" : "icon.ico");
}

function getDevIconPath() {
  return path.join(__dirname, "build", process.platform === "darwin" ? "icon.icns" : "icon.ico");
}

function getAppIconPath() {
  return app.isPackaged ? getPackagedIconPath() : getDevIconPath();
}

function loadAppIcon() {
  const iconPath = getAppIconPath();
  if (fs.existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) return icon;
  }
  return null;
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), WINDOW_STATE_FILE);
}

function clampPetScale(scale) {
  const value = Number(scale);
  if (!Number.isFinite(value)) return 1;
  return Math.min(PET_SCALE_LIMITS.max, Math.max(PET_SCALE_LIMITS.min, value));
}

function defaultPetWindowState(petId) {
  return {
    petId,
    companionMode: false,
    bubbleEditorOpen: false
  };
}

function defaultState() {
  return {
    alwaysOnTop: true,
    openAtLogin: true,
    bubbleEnabled: true,
    petScale: 1,
    hideDockIcon: false,
    petWindows: [defaultPetWindowState("minji")]
  };
}

function normalizePetWindowState(entry) {
  if (!entry || !PET_ID_SET.has(entry.petId)) return null;

  const next = {
    ...defaultPetWindowState(entry.petId),
    companionMode: Boolean(entry.companionMode),
    bubbleEditorOpen: false
  };

  if (typeof entry.x === "number") next.x = Math.round(entry.x);
  if (typeof entry.y === "number") next.y = Math.round(entry.y);

  return next;
}

function normalizeState(savedState) {
  const base = defaultState();
  const seen = new Set();
  const petWindowsState = [];

  if (Array.isArray(savedState.petWindows)) {
    for (const entry of savedState.petWindows) {
      const normalized = normalizePetWindowState(entry);
      if (!normalized || seen.has(normalized.petId)) continue;
      seen.add(normalized.petId);
      petWindowsState.push(normalized);
    }
  }

  if (!petWindowsState.length && PET_ID_SET.has(savedState.selectedPetId)) {
    const migrated = normalizePetWindowState({
      petId: savedState.selectedPetId,
      x: savedState.x,
      y: savedState.y,
      companionMode: savedState.companionMode
    });
    if (migrated) {
      seen.add(migrated.petId);
      petWindowsState.push(migrated);
    }
  }

  return {
    ...base,
    alwaysOnTop: savedState.alwaysOnTop === undefined ? base.alwaysOnTop : Boolean(savedState.alwaysOnTop),
    openAtLogin: savedState.openAtLogin === undefined ? base.openAtLogin : Boolean(savedState.openAtLogin),
    bubbleEnabled: savedState.bubbleEnabled === undefined ? base.bubbleEnabled : Boolean(savedState.bubbleEnabled),
    petScale: clampPetScale(savedState.petScale),
    hideDockIcon: Boolean(savedState.hideDockIcon),
    petWindows: petWindowsState
  };
}

function readWindowState() {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function writeWindowState() {
  if (!currentState) currentState = defaultState();
  try {
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(currentState, null, 2));
  } catch {
    // Ignore persistence failures so the app remains usable.
  }
}

function getPetWindowState(petId) {
  return currentState.petWindows.find((entry) => entry.petId === petId) || null;
}

function ensurePetWindowState(petId) {
  let petState = getPetWindowState(petId);
  if (petState) return petState;

  petState = defaultPetWindowState(petId);
  currentState.petWindows.push(petState);
  writeWindowState();
  return petState;
}

function getWindowSizeForPetScale(scale, options = {}) {
  const normalizedScale = clampPetScale(scale);
  const petWidth = 220 * normalizedScale;
  const petHeight = petWidth / PET_ASPECT_RATIO;

  if (options.bubbleEditorOpen) {
    return { width: 660, height: 520 };
  }

  if (options.companionMode) {
    return {
      width: Math.max(304, Math.round(petWidth + 48)),
      height: Math.max(198, Math.round(petHeight + 118))
    };
  }

  return {
    width: Math.max(214, Math.round(petWidth + 64)),
    height: Math.max(410, Math.round(petHeight + 330))
  };
}

function getWindowSizeForPet(petId) {
  const petState = ensurePetWindowState(petId);
  return getWindowSizeForPetScale(currentState.petScale, {
    companionMode: petState.companionMode,
    bubbleEditorOpen: petState.bubbleEditorOpen
  });
}

function clampBoundsToWorkArea(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const { workArea } = display;
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height);

  return {
    ...bounds,
    x: Math.round(x),
    y: Math.round(y)
  };
}

function getDefaultBoundsForPet(petId) {
  const target = getWindowSizeForPet(petId);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  const index = Math.max(0, currentState.petWindows.findIndex((entry) => entry.petId === petId));
  const column = index % 3;
  const row = Math.floor(index / 3);

  return clampBoundsToWorkArea({
    x: Math.round(workArea.x + workArea.width - target.width - 48 - column * 42),
    y: Math.round(workArea.y + workArea.height - target.height - 64 - row * 28),
    width: target.width,
    height: target.height
  });
}

function syncBoundsIntoState(window) {
  if (!window || window.isDestroyed()) return;

  const petState = getPetWindowState(window.petId);
  if (!petState) return;

  const bounds = window.getBounds();
  petState.x = bounds.x;
  petState.y = bounds.y;
}

function writeWindowStateForWindow(window) {
  syncBoundsIntoState(window);
  writeWindowState();
}

function listActivePetIds() {
  return currentState.petWindows.map((entry) => entry.petId);
}

function sendShellSettings(window) {
  if (!window || window.isDestroyed()) return;
  const petState = ensurePetWindowState(window.petId);

  window.webContents.send("shell:settings", {
    alwaysOnTop: currentState.alwaysOnTop,
    openAtLogin: currentState.openAtLogin,
    bubbleEnabled: currentState.bubbleEnabled,
    companionMode: petState.companionMode,
    petId: window.petId,
    activePetIds: listActivePetIds(),
    hideDockIcon: currentState.hideDockIcon,
    petScale: currentState.petScale
  });
}

function broadcastSettings() {
  for (const window of petWindows.values()) {
    sendShellSettings(window);
  }
}

function broadcastBubbleEnabled() {
  for (const window of petWindows.values()) {
    if (!window.isDestroyed()) {
      window.webContents.send("shell:bubbles-enabled", currentState.bubbleEnabled);
    }
  }
}

function createTrayIcon() {
  const fileIcon = loadAppIcon();
  if (fileIcon) return fileIcon;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="28" fill="#ffffff"/>
      <circle cx="22" cy="26" r="3.5" fill="#111111"/>
      <circle cx="42" cy="26" r="3.5" fill="#111111"/>
      <path d="M20 38 C26 44, 38 44, 44 38" fill="none" stroke="#111111" stroke-width="4" stroke-linecap="round"/>
      <path d="M32 49 L26 43 C23 40, 23 35, 27 33 C29 32, 31 33, 32 35 C33 33, 35 32, 37 33 C41 35, 41 40, 38 43 Z" fill="#ef174f"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function shouldSkipTaskbar() {
  return process.platform === "win32" ? currentState.hideDockIcon : false;
}

function getHideAppIconLabel() {
  if (process.platform === "darwin") return "Hide Dock Icon";
  if (process.platform === "win32") return "Hide Taskbar Icon";
  return "Hide App Icon";
}

function anyPetVisible() {
  return Array.from(petWindows.values()).some((window) => !window.isDestroyed() && window.isVisible());
}

function showPetWindow(petId) {
  let window = petWindows.get(petId);
  if (!window || window.isDestroyed()) {
    window = createPetWindow(petId);
  }

  if (!window.isVisible()) window.show();
  return window;
}

function showAllPets() {
  let firstWindow = null;

  for (const petId of listActivePetIds()) {
    const window = showPetWindow(petId);
    if (!firstWindow) firstWindow = window;
  }

  if (firstWindow && !firstWindow.isDestroyed()) {
    firstWindow.focus();
  }
}

function hideAllPets() {
  for (const window of petWindows.values()) {
    if (window.isDestroyed()) continue;
    stopWindowDrag(window);
    writeWindowStateForWindow(window);
    window.hide();
  }
}

function applyWindowSizeForPet(window, anchor = "center") {
  if (!window || window.isDestroyed()) return;

  const target = getWindowSizeForPet(window.petId);
  const bounds = window.getBounds();
  const nextBounds = anchor === "bottom"
    ? {
        x: Math.round(bounds.x + bounds.width / 2 - target.width / 2),
        y: Math.round(bounds.y + bounds.height - target.height),
        width: target.width,
        height: target.height
      }
    : {
        x: Math.round(bounds.x + bounds.width / 2 - target.width / 2),
        y: Math.round(bounds.y + bounds.height / 2 - target.height / 2),
        width: target.width,
        height: target.height
      };

  if (target.width >= bounds.width || target.height >= bounds.height) {
    window.setMaximumSize(target.width, target.height);
    window.setMinimumSize(target.width, target.height);
  } else {
    window.setMinimumSize(target.width, target.height);
    window.setMaximumSize(target.width, target.height);
  }

  window.setBounds(clampBoundsToWorkArea(nextBounds));
  writeWindowStateForWindow(window);
}

function setAlwaysOnTop(enabled) {
  currentState.alwaysOnTop = Boolean(enabled);

  for (const window of petWindows.values()) {
    if (window.isDestroyed()) continue;
    window.setAlwaysOnTop(currentState.alwaysOnTop, "screen-saver");
  }

  writeWindowState();
  refreshTrayMenu();
  broadcastSettings();
  return currentState.alwaysOnTop;
}

function setBubbleEnabled(enabled) {
  currentState.bubbleEnabled = Boolean(enabled);
  writeWindowState();
  refreshTrayMenu();
  broadcastSettings();
  broadcastBubbleEnabled();
}

function applyLoginItemSetting(enabled) {
  currentState.openAtLogin = Boolean(enabled);
  app.setLoginItemSettings({
    openAtLogin: currentState.openAtLogin,
    path: process.execPath,
    args: []
  });
  writeWindowState();
  refreshTrayMenu();
  broadcastSettings();
}

function applyDockVisibility(hideDockIcon) {
  currentState.hideDockIcon = Boolean(hideDockIcon);

  if (process.platform === "darwin" && app.dock) {
    if (currentState.hideDockIcon) app.dock.hide();
    else app.dock.show();
  }

  for (const window of petWindows.values()) {
    if (window.isDestroyed()) continue;
    window.setSkipTaskbar(shouldSkipTaskbar());
  }

  writeWindowState();
  refreshTrayMenu();
  broadcastSettings();
}

function setPetScale(scale) {
  currentState.petScale = clampPetScale(scale);

  for (const window of petWindows.values()) {
    applyWindowSizeForPet(window, "center");
  }

  writeWindowState();
  refreshTrayMenu();
  broadcastSettings();
}

function setCompanionMode(window, enabled) {
  if (!window || window.isDestroyed()) return false;

  const petState = ensurePetWindowState(window.petId);
  petState.companionMode = Boolean(enabled);
  applyWindowSizeForPet(window, "center");
  sendShellSettings(window);
  return petState.companionMode;
}

function setBubbleEditorOpen(window, open) {
  if (!window || window.isDestroyed()) return false;

  const petState = ensurePetWindowState(window.petId);
  petState.bubbleEditorOpen = Boolean(open);
  applyWindowSizeForPet(window, "center");
  sendShellSettings(window);
  return petState.bubbleEditorOpen;
}

function stopWindowDrag(window) {
  if (!window) return;

  const session = dragSessions.get(window.petId);
  if (!session) return;

  clearInterval(session.timer);
  dragSessions.delete(window.petId);
  writeWindowStateForWindow(window);
}

function startWindowDrag(window) {
  if (!window || window.isDestroyed()) return false;

  stopWindowDrag(window);
  const cursor = screen.getCursorScreenPoint();
  const bounds = window.getBounds();

  dragSessions.set(window.petId, {
    cursor,
    bounds,
    timer: setInterval(() => {
      const session = dragSessions.get(window.petId);
      if (!session || window.isDestroyed()) {
        stopWindowDrag(window);
        return;
      }

      const nextCursor = screen.getCursorScreenPoint();
      window.setPosition(
        session.bounds.x + nextCursor.x - session.cursor.x,
        session.bounds.y + nextCursor.y - session.cursor.y
      );
    }, 16)
  });

  return true;
}

function resetAllPetPositions() {
  for (const petId of listActivePetIds()) {
    const window = showPetWindow(petId);
    window.setBounds(getDefaultBoundsForPet(petId));
    writeWindowStateForWindow(window);
  }
}

function addPetToDesktop(petId) {
  if (!PET_ID_SET.has(petId)) return;
  if (!getPetWindowState(petId)) {
    currentState.petWindows.push(defaultPetWindowState(petId));
    writeWindowState();
  }

  const window = showPetWindow(petId);
  window.setAlwaysOnTop(currentState.alwaysOnTop, "screen-saver");
  refreshTrayMenu();
  broadcastSettings();
}

function removePetFromDesktop(petId) {
  currentState.petWindows = currentState.petWindows.filter((entry) => entry.petId !== petId);
  writeWindowState();

  const window = petWindows.get(petId);
  if (window && !window.isDestroyed()) {
    closingPets.add(petId);
    stopWindowDrag(window);
    window.close();
  }

  petWindows.delete(petId);
  refreshTrayMenu();
  broadcastSettings();
}

function refreshTrayMenu() {
  if (!tray) return;

  const petSubmenu = PET_OPTIONS.map((pet) => ({
    label: pet.label,
    type: "checkbox",
    checked: Boolean(getPetWindowState(pet.id)),
    click: (item) => {
      if (item.checked) addPetToDesktop(pet.id);
      else removePetFromDesktop(pet.id);
    }
  }));

  const menuTemplate = [
    {
      label: "Show All Pets",
      click: () => {
        if (!currentState.petWindows.length) addPetToDesktop(PET_OPTIONS[0].id);
        else showAllPets();
      }
    },
    { label: "Hide All Pets", click: () => hideAllPets() },
    { type: "separator" },
    { label: "Pets On Desktop", submenu: petSubmenu },
    {
      label: "Show Bubbles",
      type: "checkbox",
      checked: currentState.bubbleEnabled,
      click: (item) => setBubbleEnabled(item.checked)
    },
    {
      label: "Always On Top",
      type: "checkbox",
      checked: currentState.alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked)
    }
  ];

  if (process.platform === "darwin" || process.platform === "win32") {
    menuTemplate.push({
      label: getHideAppIconLabel(),
      type: "checkbox",
      checked: currentState.hideDockIcon,
      click: (item) => applyDockVisibility(item.checked)
    });
  }

  menuTemplate.push(
    {
      label: "Open At Login",
      type: "checkbox",
      checked: currentState.openAtLogin,
      click: (item) => applyLoginItemSetting(item.checked)
    },
    { label: "Reset Positions", click: () => resetAllPetPositions() },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("NewJeans Pets");
  tray.on("click", () => {
    if (process.platform === "darwin") {
      tray.popUpContextMenu();
      return;
    }

    if (!currentState.petWindows.length) {
      addPetToDesktop(PET_OPTIONS[0].id);
      return;
    }

    if (anyPetVisible()) hideAllPets();
    else showAllPets();
  });
  refreshTrayMenu();
}

function createPetWindow(petId) {
  const petState = ensurePetWindowState(petId);
  const size = getWindowSizeForPet(petId);
  const initialBounds = typeof petState.x === "number" && typeof petState.y === "number"
    ? clampBoundsToWorkArea({ x: petState.x, y: petState.y, width: size.width, height: size.height })
    : getDefaultBoundsForPet(petId);

  const petLabel = PET_OPTIONS.find((pet) => pet.id === petId)?.label || petId;
  const window = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: initialBounds.width,
    minHeight: initialBounds.height,
    maxWidth: initialBounds.width,
    maxHeight: initialBounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    skipTaskbar: shouldSkipTaskbar(),
    alwaysOnTop: currentState.alwaysOnTop,
    title: `NewJeans Pets - ${petLabel}`,
    icon: getAppIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false
    }
  });

  window.petId = petId;
  window.setAlwaysOnTop(currentState.alwaysOnTop, "screen-saver");

  window.once("ready-to-show", () => {
    if (typeof petState.x !== "number" || typeof petState.y !== "number") {
      window.setBounds(getDefaultBoundsForPet(petId));
      writeWindowStateForWindow(window);
    }

    window.show();
    sendShellSettings(window);
    window.webContents.send("shell:bubbles-enabled", currentState.bubbleEnabled);
  });

  window.on("close", (event) => {
    if (isQuitting || closingPets.has(petId)) {
      stopWindowDrag(window);
      writeWindowStateForWindow(window);
      return;
    }

    event.preventDefault();
    hideAllPets();
  });

  window.on("closed", () => {
    stopWindowDrag(window);
    closingPets.delete(petId);
    petWindows.delete(petId);
    refreshTrayMenu();
  });

  window.on("move", () => writeWindowStateForWindow(window));
  window.on("blur", () => stopWindowDrag(window));
  window.on("show", () => sendShellSettings(window));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  window.loadFile(path.join(__dirname, "index.html"));
  petWindows.set(petId, window);
  return window;
}

function getEventWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle("shell:toggle-always-on-top", () => {
  return { alwaysOnTop: setAlwaysOnTop(!currentState.alwaysOnTop) };
});

ipcMain.handle("shell:set-pet-scale", (_event, scale) => {
  setPetScale(scale);
  return { petScale: currentState.petScale };
});

ipcMain.handle("shell:set-companion-mode", (event, enabled) => {
  const window = getEventWindow(event);
  return { companionMode: setCompanionMode(window, enabled) };
});

ipcMain.handle("shell:set-bubble-editor-open", (event, open) => {
  const window = getEventWindow(event);
  return { bubbleEditorOpen: setBubbleEditorOpen(window, open) };
});

ipcMain.handle("shell:start-window-drag", (event) => {
  return { ok: startWindowDrag(getEventWindow(event)) };
});

ipcMain.handle("shell:stop-window-drag", (event) => {
  stopWindowDrag(getEventWindow(event));
  return { ok: true };
});

ipcMain.handle("shell:hide-window", () => {
  hideAllPets();
  return { ok: true };
});

ipcMain.handle("shell:close-current-pet", (event) => {
  const window = getEventWindow(event);
  if (window?.petId) {
    removePetFromDesktop(window.petId);
  }
  return { ok: true };
});

ipcMain.handle("shell:quit", () => {
  isQuitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle("shell:get-settings", (event) => {
  const window = getEventWindow(event);
  const petState = window?.petId ? ensurePetWindowState(window.petId) : defaultPetWindowState(PET_OPTIONS[0].id);
  return {
    alwaysOnTop: currentState.alwaysOnTop,
    openAtLogin: currentState.openAtLogin,
    bubbleEnabled: currentState.bubbleEnabled,
    companionMode: petState.companionMode,
    petId: window?.petId || currentState.petWindows[0]?.petId || PET_OPTIONS[0].id,
    activePetIds: listActivePetIds(),
    hideDockIcon: currentState.hideDockIcon,
    petScale: currentState.petScale
  };
});

ipcMain.handle("shell:set-bubble-enabled", (_event, enabled) => {
  setBubbleEnabled(enabled);
  return { bubbleEnabled: currentState.bubbleEnabled };
});

ipcMain.handle("shell:reset-position", () => {
  resetAllPetPositions();
  return { ok: true };
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!currentState.petWindows.length) {
      addPetToDesktop(PET_OPTIONS[0].id);
      return;
    }
    showAllPets();
  });

  app.whenReady().then(() => {
    currentState = readWindowState();

    for (const petId of listActivePetIds()) {
      createPetWindow(petId);
    }

    createTray();
    applyDockVisibility(currentState.hideDockIcon);
    applyLoginItemSetting(currentState.openAtLogin);

    app.on("activate", () => {
      if (!currentState.petWindows.length) {
        addPetToDesktop(PET_OPTIONS[0].id);
      } else if (BrowserWindow.getAllWindows().length === 0) {
        for (const petId of listActivePetIds()) {
          createPetWindow(petId);
        }
      } else {
        showAllPets();
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    for (const window of petWindows.values()) {
      writeWindowStateForWindow(window);
    }
  });

  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });
}
