import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkForNewerMacBuild, RELEASE_PAGE_URL } from './main/mac-update-check.js';
import { buildExport } from './main/export-service.js';
import { convertLatexToMathML } from './main/mathml.js';
import { rendererSandboxEnabled } from './main/renderer-sandbox.js';
import { exportLatex, importLatex } from './main/math-service.js';
import { createSettingsStorage } from './main/settings-storage.js';
import { createStorage } from './main/storage.js';
import { shouldRunWindowsAutoUpdate, startWindowsAutoUpdate } from './main/updater.js';
import { backTranslateUeb, translateUeb } from './main/ueb-service.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.join(sourceDirectory, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;

const isAutomatedTest = Boolean(process.env.OMNIYA_TEST_USER_DATA_DIR);
// Test-only knob: hold math:convert open for N ms so e2e tests can land input
// (e.g. Escape) inside the real IPC round-trip window without racing a fast
// local conversion. Zero/unset in every non-test run.
// Test-only: when set, an export is written straight into this folder instead of
// asking where to save it, and printing is skipped. Unset in every normal run.
const testExportDirectory = process.env.OMNIYA_TEST_EXPORT_DIR || '';
const mathConvertDelayMs = Number(process.env.OMNIYA_TEST_MATH_CONVERT_DELAY_MS) || 0;
// E2E / corpus runs should not steal focus or flash windows on the desktop.
// Playwright still drives the hidden BrowserWindow and can capture screenshots.
// Do not append Chromium --headless here: Playwright's Electron launcher needs
// a real BrowserWindow + remote debugging, which that switch breaks.
// OMNIYA_HEADLESS=0 forces a visible window even when a test userData dir is set
// (headed demos). Unset + test userData still defaults to hidden.
const runHeadless = process.env.OMNIYA_HEADLESS === '0'
  ? false
  : process.env.OMNIYA_HEADLESS === '1' || isAutomatedTest;

if (process.env.OMNIYA_TEST_USER_DATA_DIR) {
  app.setPath('userData', process.env.OMNIYA_TEST_USER_DATA_DIR);
}
// Always on, except in an isolated test run inside an outer sandbox. See renderer-sandbox.js.
const useRendererSandbox = rendererSandboxEnabled(process.env);
if (useRendererSandbox) app.enableSandbox();

function assertTrustedSender(event) {
  if (event.senderFrame?.url !== rendererUrl) {
    throw new Error('Untrusted renderer');
  }
}

function registerIpc(storage, settingsStorage) {
  ipcMain.handle('state:load', async (event) => {
    assertTrustedSender(event);
    return storage.load();
  });
  ipcMain.handle('state:save', async (event, state) => {
    assertTrustedSender(event);
    return storage.save(state);
  });
  ipcMain.handle('settings:load', async (event) => {
    assertTrustedSender(event);
    return settingsStorage.load();
  });
  ipcMain.handle('settings:save', async (event, settings) => {
    assertTrustedSender(event);
    return settingsStorage.save(settings);
  });
  ipcMain.handle('math:convert', async (event, source) => {
    assertTrustedSender(event);
    if (mathConvertDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mathConvertDelayMs));
    // Half-typed LaTeX is the normal state of the live preview. Throwing here
    // makes Electron print every one, so the refusal travels as a value and the
    // preload turns it back into an error on the renderer side.
    try {
      return { mathml: await convertLatexToMathML(source) };
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle('math:import', async (event, source) => { assertTrustedSender(event); return importLatex(source); });
  ipcMain.handle('math:export', async (event, document) => { assertTrustedSender(event); return exportLatex(document); });
  ipcMain.handle('ueb:translate', async (event, { text, grade }) => {
    assertTrustedSender(event);
    return { braille: await translateUeb(text, grade) };
  });
  ipcMain.handle('ueb:backTranslate', async (event, { braille, grade }) => {
    assertTrustedSender(event);
    return { text: await backTranslateUeb(braille, grade) };
  });
  ipcMain.handle('export:note', async (event, request) => {
    assertTrustedSender(event);
    const { fileName, content, spec } = buildExport(request ?? {});
    if (testExportDirectory) {
      const target = path.join(testExportDirectory, fileName);
      await writeFile(target, content, 'utf8');
      return { saved: true, fileName, path: target };
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    const choice = await dialog.showSaveDialog(window, {
      title: 'Export note',
      defaultPath: fileName,
      filters: [{ name: spec.label, extensions: [spec.extension] }]
    });
    if (choice.canceled || !choice.filePath) return { saved: false };
    await writeFile(choice.filePath, content, 'utf8');
    return { saved: true, fileName: path.basename(choice.filePath) };
  });
  ipcMain.handle('export:print', async (event) => {
    assertTrustedSender(event);
    if (testExportDirectory) return { printed: false, skipped: true };
    event.sender.print({ printBackground: false });
    return { printed: true };
  });
  // The page's own clipboard call needs window focus and a browser permission,
  // and a contributor on Windows got an empty paste from it. The main
  // process clipboard needs neither.
  ipcMain.handle('clipboard:writeText', (event, text) => {
    assertTrustedSender(event);
    if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string.');
    clipboard.writeText(text);
  });
  ipcMain.handle('update:openReleasePage', async (event) => {
    assertTrustedSender(event);
    await shell.openExternal(RELEASE_PAGE_URL);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: !runHeadless,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: useRendererSandbox,
      preload: path.join(sourceDirectory, 'preload.cjs'),
      // The build identity, for the renderer to display. Passed as an argv flag
      // rather than over IPC or in the URL: a sandboxed preload can read
      // process.argv with no handler to guard, and any query string on the URL
      // would break `assertTrustedSender`, which compares senderFrame.url
      // exactly -- that would silently disable every IPC call in the app.
      additionalArguments: [
        `--omniya-app-version=${app.getVersion()}`,
        // Dev tools flag. Three independent things must all hold before the
        // inspector can exist: this env var, an unpackaged app, and the module
        // itself being present -- and `electron-builder.yml` excludes
        // `src/renderer/dev` from the asar, so in a shipped build there is no
        // file to import even if the first two were somehow satisfied.
        ...(!app.isPackaged && process.env.OMNIYA_DEV_TOOLS === '1' ? ['--omniya-dev-tools'] : [])
      ]
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  void window.loadFile(rendererFile);
  return window;
}

function checkForMacUpdateBanner(window) {
  checkForNewerMacBuild(app.getVersion())
    .then(({ available, latestVersion, releaseUrl }) => {
      if (!available || window.isDestroyed()) return;
      window.webContents.send('update:notice', { kind: 'available', latestVersion, releaseUrl });
    })
    .catch((err) => console.error('[omniya:update] mac check failed', err));
}

function sendMenuCommand(payload) {
  // The window that has focus. A menu item can also run with no focused window
  // (a hidden test window, or the app just activated), so fall back to the only one.
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send('menu:command', payload);
}

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const template = [];
  if (isMac) template.push({ role: 'appMenu' });
  // Edit is built by hand, not with `role: 'editMenu'`. That role's Undo and Redo
  // run the browser's own undo, which knows nothing about the editor's history:
  // Cmd/Ctrl+Z did nothing for equations and Redo did nothing at all. These two
  // go to the app, which sends them to the editor. Cut, Copy, Paste and Select All
  // are the browser's own and work as they are.
  // File, as in Word: a new document is Ctrl/Cmd+N. A note is a document.
  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New note',
        accelerator: 'CmdOrCtrl+N',
        click: () => sendMenuCommand({ action: 'new-note' })
      },
      {
        label: 'Export note…',
        click: () => sendMenuCommand({ action: 'export' })
      },
      {
        label: 'Print…',
        accelerator: 'CmdOrCtrl+P',
        click: () => sendMenuCommand({ action: 'print' })
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  });
  template.push({
    label: 'Edit',
    submenu: [
      {
        id: 'undo',
        label: 'Undo',
        accelerator: 'CmdOrCtrl+Z',
        click: () => sendMenuCommand({ action: 'undo' })
      },
      {
        id: 'redo',
        label: 'Redo',
        accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
        click: () => sendMenuCommand({ action: 'redo' })
      },
      { type: 'separator' },
      {
        label: 'Find in note…',
        accelerator: 'CmdOrCtrl+F',
        click: () => sendMenuCommand({ action: 'find' })
      },
      {
        label: 'Find next',
        accelerator: isMac ? 'Cmd+G' : 'F3',
        click: () => sendMenuCommand({ action: 'find-next' })
      },
      {
        label: 'Find previous',
        accelerator: isMac ? 'Shift+Cmd+G' : 'Shift+F3',
        click: () => sendMenuCommand({ action: 'find-previous' })
      },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  });
  template.push(
    {
      label: 'Insert',
      submenu: [
        {
          // Word's own keys: Alt+= on Windows, Control+= on Mac. The key itself
          // is handled in the editor (src/renderer/editor/index.js); this label
          // is the menu's reminder of it. It uses the last method chosen.
          label: `Equation\t${isMac ? 'Ctrl' : 'Alt'}+=`,
          click: () => sendMenuCommand({ action: 'insert-equation' })
        },
        {
          label: 'Equation (Nemeth)',
          click: () => sendMenuCommand({ action: 'insert-equation', method: 'nemeth' })
        },
        {
          label: 'Equation (LaTeX)',
          click: () => sendMenuCommand({ action: 'insert-equation', method: 'latex' })
        }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard shortcuts',
          click: () => sendMenuCommand({ action: 'keyboard-help' })
        },
        {
          // Rides the menu-command bridge to the page, which builds the report.
          // The page then hands the text to the main process to copy
          // ('clipboard:writeText', guarded by assertTrustedSender), because the
          // page's own clipboard call failed on a contributor's Windows machine.
          label: 'Copy braille input diagnostics',
          click: () => sendMenuCommand({ action: 'copy-input-diagnostics' })
        }
      ]
    }
  );
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  if (runHeadless && app.dock) app.dock.hide();
  const externalFile = process.env.OMNIYA_NAPKIN_FILE
    ? path.resolve(process.env.OMNIYA_NAPKIN_FILE)
    : null;
  const storage = externalFile
    ? createStorage(path.dirname(externalFile), { fileName: path.basename(externalFile) })
    : createStorage(app.getPath('userData'));
  const settingsStorage = createSettingsStorage(app.getPath('userData'));
  registerIpc(storage, settingsStorage);
  const window = createWindow();
  Menu.setApplicationMenu(buildApplicationMenu());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (shouldRunWindowsAutoUpdate({ platform: process.platform, isPackaged: app.isPackaged, isAutomatedTest })) {
    void startWindowsAutoUpdate({
      // Say so in the app when updates have quietly stopped arriving. Silence
      // here once let testers run a stale build for days while believing they
      // were current -- see createUpdateHealth.
      onStalled: () => {
        const target = BrowserWindow.getAllWindows()[0];
        if (!target || target.isDestroyed()) return;
        target.webContents.send('update:notice', { kind: 'stalled', releaseUrl: RELEASE_PAGE_URL });
      }
    });
  } else if (process.platform === 'darwin' && app.isPackaged && !isAutomatedTest) {
    checkForMacUpdateBanner(window);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
