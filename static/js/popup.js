import {
    MAX_USER_TABS,
    UNLOCK_MS,
    UNLOCK_PREFIX,
    base64ToBytes,
    cacheUnlockKey,
    clearUnlockKey,
    createPlainTab,
    decryptText,
    deriveKeyBytes,
    encryptText,
    getCachedUnlockKey,
    getOrMigrateState,
    isEncryptedTab,
    isInbox,
    isValidState,
    saveState
} from './storage.js';
import { DEFAULT_PLAN_ID, getPlanLimits } from './plans.js';

const AUTOSAVE_DELAY = 300;
const MIN_PASSWORD_LENGTH = 8;
const THEME_KEY = 'text_saver_theme';
const BACKUP_FORMAT = 'text-saver-backup';
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const activePlan = getPlanLimits(DEFAULT_PLAN_ID);

const textarea = document.getElementById('formats');
const tabsContainer = document.getElementById('tabs');
const addTabButton = document.getElementById('add-tab');
const textNumber = document.getElementById('text-number');
const wordNumber = document.getElementById('word-number');
const lineNumber = document.getElementById('line-number');
const copyButton = document.getElementById('copy');
const saveButton = document.getElementById('save');
const saveStatus = document.getElementById('save-status');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const headerActions = document.getElementById('header-actions');
const protectTabButton = document.getElementById('protect-tab');
const protectTabIcon = document.getElementById('protect-tab-icon');
const renameTabButton = document.getElementById('rename-tab');
const deleteTabButton = document.getElementById('delete-tab');
const overflowToggle = document.getElementById('overflow-toggle');
const overflowMenu = document.getElementById('overflow-menu');
const exportBackupButton = document.getElementById('export-backup');
const importBackupButton = document.getElementById('import-backup');
const backupFileInput = document.getElementById('backup-file');
const lineNumbers = document.getElementById('line-numbers');
const lockedState = document.getElementById('locked-state');
const unlockTabButton = document.getElementById('unlock-tab');
const resetTabButton = document.getElementById('reset-tab');
const modalBackdrop = document.getElementById('modal-backdrop');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalInput = document.getElementById('modal-input');
const modalInputLabel = document.getElementById('modal-input-label');
const modalInputTwo = document.getElementById('modal-input-two');
const modalInputTwoLabel = document.getElementById('modal-input-two-label');
const modalError = document.getElementById('modal-error');
const modalOptions = document.getElementById('modal-options');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const toast = document.getElementById('toast');

let state;
let saveTimer;
let saveQueue = Promise.resolve();
let saveRevision = 0;
let textEditPending = false;
let modalResolver;
let modalConfig;
let modalReturnFocus;
const unlockedKeys = new Map();
const unlockedText = new Map();
const lockTimers = new Map();
let currentTheme = 'dark';
let toastTimer;

textarea.maxLength = activePlan.maxCharactersPerTab;

function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('visible');
    toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
    }, 1800);
}

function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = currentTheme;
    const isLight = currentTheme === 'light';
    themeIcon.src = isLight ? 'static/svgs/dark.svg' : 'static/svgs/sun.svg';
    themeToggle.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    themeToggle.setAttribute('aria-label', themeToggle.title);
    themeToggle.setAttribute('aria-pressed', String(isLight));
}

async function loadTheme() {
    try {
        const stored = await chrome.storage.local.get(THEME_KEY);
        applyTheme(stored[THEME_KEY] === 'light' ? 'light' : 'dark');
    } catch (error) {
        applyTheme('dark');
        console.error('Text Saver could not load the theme preference.', error);
    }
}

async function toggleTheme() {
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    try {
        await chrome.storage.local.set({ [THEME_KEY]: nextTheme });
    } catch (error) {
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
        console.error('Text Saver could not save the theme preference.', error);
    }
}

function getActiveTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
}

function normalTabCount() {
    return state.tabs.filter((tab) => !isInbox(tab)).length;
}

function isUnlocked(tab) {
    return !isEncryptedTab(tab) || unlockedKeys.has(tab.id);
}

function closeModal(result) {
    if (!modalResolver) return;
    const resolve = modalResolver;
    modalResolver = undefined;
    modalConfig = undefined;
    modalBackdrop.hidden = true;
    modalReturnFocus?.focus();
    modalReturnFocus = undefined;
    resolve(result);
}

function configureInput(input, label, config) {
    const visible = Boolean(config);
    input.hidden = !visible;
    label.hidden = !visible;
    if (!visible) return;
    label.textContent = config.label || '';
    input.type = config.type || 'text';
    input.autocomplete = config.autocomplete || 'off';
    input.value = config.value || '';
}

function openModal({
    title,
    message,
    confirmLabel = 'Confirm',
    input,
    inputTwo,
    options,
    validate
}) {
    if (modalResolver) closeModal(null);
    modalReturnFocus = document.activeElement;
    modalTitle.textContent = title;
    modalMessage.textContent = message || '';
    modalConfirm.textContent = confirmLabel;
    modalError.hidden = true;
    modalError.textContent = '';
    configureInput(modalInput, modalInputLabel, input);
    configureInput(modalInputTwo, modalInputTwoLabel, inputTwo);
    modalOptions.replaceChildren();
    modalOptions.hidden = !options;
    modalConfirm.hidden = Boolean(options);

    if (options) {
        options.forEach((option) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'modal-button modal-option';
            button.textContent = option.label;
            button.addEventListener('click', () => closeModal(option.value));
            modalOptions.append(button);
        });
    }

    modalConfig = { validate, hasInput: Boolean(input), hasInputTwo: Boolean(inputTwo) };
    modalBackdrop.hidden = false;
    setTimeout(() => {
        if (input) {
            modalInput.focus();
            modalInput.select();
        } else {
            modalCancel.focus();
        }
    });

    return new Promise((resolve) => {
        modalResolver = resolve;
    });
}

async function submitModal() {
    if (!modalResolver || modalConfirm.hidden) return;
    modalConfirm.disabled = true;
    modalError.hidden = true;
    try {
        const values = [
            modalConfig.hasInput ? modalInput.value : undefined,
            modalConfig.hasInputTwo ? modalInputTwo.value : undefined
        ];
        const validationError = modalConfig.validate ? await modalConfig.validate(...values) : null;
        if (validationError) {
            modalError.textContent = validationError;
            modalError.hidden = false;
            modalInput.focus();
            return;
        }
        if (modalConfig.hasInputTwo) closeModal(values);
        else if (modalConfig.hasInput) closeModal(values[0]);
        else closeModal(true);
    } finally {
        modalConfirm.disabled = false;
    }
}

modalCancel.addEventListener('click', () => closeModal(null));
modalConfirm.addEventListener('click', submitModal);
modalBackdrop.addEventListener('click', (event) => {
    if (event.target === modalBackdrop) closeModal(null);
});
modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(null);
    } else if (event.key === 'Enter' && !modalConfirm.hidden) {
        event.preventDefault();
        submitModal();
    }
});

tabsContainer.addEventListener('wheel', (event) => {
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    const maxScrollLeft = tabsContainer.scrollWidth - tabsContainer.clientWidth;
    const canScroll = (delta < 0 && tabsContainer.scrollLeft > 0)
        || (delta > 0 && tabsContainer.scrollLeft < maxScrollLeft);
    if (!canScroll) return;
    event.preventDefault();
    tabsContainer.scrollLeft += delta;
}, { passive: false });

function updateTextNumber() {
    const text = textarea.value;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lineCount = text ? text.split('\n').length : 0;
    wordNumber.textContent = wordCount.toLocaleString('en-US');
    textNumber.textContent = text.length.toLocaleString('en-US');
    lineNumber.textContent = lineCount.toLocaleString('en-US');
}

function textAfterInsertion(insertedText) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    return textarea.value.slice(0, start) + insertedText + textarea.value.slice(end);
}

function insertionLimitMessage(insertedText) {
    const nextText = textAfterInsertion(insertedText);
    if (nextText.length > activePlan.maxCharactersPerTab) {
        return `Maximum ${activePlan.maxCharactersPerTab.toLocaleString('en-US')} characters per tab`;
    }
    const nextLineCount = nextText ? nextText.split('\n').length : 0;
    if (nextLineCount > activePlan.maxLinesPerTab) {
        return `Maximum ${activePlan.maxLinesPerTab.toLocaleString('en-US')} lines per tab`;
    }
    return null;
}

function measureWrappedLineHeights(lines) {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 18;
    if (!textarea.clientWidth) return lines.map(() => lineHeight);

    const mirror = document.createElement('div');
    Object.assign(mirror.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        visibility: 'hidden',
        pointerEvents: 'none',
        width: `${textarea.clientWidth}px`,
        padding: styles.padding,
        border: '0',
        boxSizing: 'border-box',
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        fontWeight: styles.fontWeight,
        fontStyle: styles.fontStyle,
        letterSpacing: styles.letterSpacing,
        lineHeight: styles.lineHeight,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        wordBreak: styles.wordBreak
    });

    const spans = lines.map((line) => {
        const span = document.createElement('span');
        span.style.display = 'block';
        span.style.minHeight = `${lineHeight}px`;
        span.textContent = line || '\u200b';
        mirror.append(span);
        return span;
    });
    document.body.append(mirror);
    const heights = spans.map((span) => Math.max(lineHeight, span.getBoundingClientRect().height));
    mirror.remove();
    return heights;
}

function updateLineNumbers() {
    const lines = textarea.value.split('\n');
    const lineHeights = measureWrappedLineHeights(lines);
    lineNumbers.replaceChildren();
    lines.forEach((line, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'line-copy';
        button.title = `Copy line ${index + 1}`;
        button.setAttribute('aria-label', `Copy line ${index + 1}`);
        button.style.flexBasis = `${lineHeights[index]}px`;
        button.style.height = `${lineHeights[index]}px`;

        const number = document.createElement('span');
        number.className = 'line-copy-number';
        number.textContent = index + 1;

        const icon = document.createElement('img');
        icon.className = 'line-copy-icon';
        icon.src = 'static/svgs/copy.svg';
        icon.alt = '';
        icon.setAttribute('aria-hidden', 'true');

        button.append(number, icon);
        button.addEventListener('click', () => copyLine(line, index + 1));
        lineNumbers.append(button);
    });
    lineNumbers.scrollTop = textarea.scrollTop;
}

function setLockedEditor(locked) {
    lockedState.hidden = !locked;
    textarea.disabled = locked;
    lineNumbers.hidden = locked;
    copyButton.disabled = locked;
    saveButton.disabled = locked;
    if (locked) textarea.value = '';
    updateTextNumber();
    updateLineNumbers();
}

function setSaveStatus(status) {
    saveStatus.textContent = status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : '';
    saveStatus.className = `save-status${status === 'saved' ? '' : ` ${status}`}`;
}

function persistState(showSavingStatus = false) {
    clearTimeout(saveTimer);
    const snapshot = structuredClone(state);
    const revision = ++saveRevision;
    if (showSavingStatus) setSaveStatus('saving');
    saveQueue = saveQueue.catch(() => undefined).then(() => saveState(snapshot));
    return saveQueue.then(() => {
        if (showSavingStatus && revision === saveRevision) setSaveStatus('saved');
    }).catch((error) => {
        if (revision === saveRevision) setSaveStatus('error');
        throw error;
    });
}

async function touchUnlock(tab) {
    if (!isEncryptedTab(tab)) return;
    const keyBytes = unlockedKeys.get(tab.id);
    if (!keyBytes) return;
    clearTimeout(lockTimers.get(tab.id));
    const expiresAt = await cacheUnlockKey(tab.id, keyBytes, Date.now() + UNLOCK_MS);
    const timer = setTimeout(() => lockTab(tab.id), Math.max(0, expiresAt - Date.now()));
    lockTimers.set(tab.id, timer);
}

async function flushEditor() {
    const tab = getActiveTab();
    if (!tab || (isEncryptedTab(tab) && !isUnlocked(tab))) return persistState();
    const showSavingStatus = textEditPending;
    if (isEncryptedTab(tab)) {
        const keyBytes = unlockedKeys.get(tab.id);
        const payload = await encryptText(textarea.value, tab.id, keyBytes, base64ToBytes(tab.salt));
        Object.assign(tab, payload);
        unlockedText.set(tab.id, textarea.value);
    } else {
        tab.text = textarea.value;
    }
    textEditPending = false;
    return persistState(showSavingStatus);
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushEditor().catch(console.error), AUTOSAVE_DELAY);
}

async function restoreCachedUnlock(tab) {
    if (!isEncryptedTab(tab) || unlockedKeys.has(tab.id)) return isUnlocked(tab);
    const cached = await getCachedUnlockKey(tab.id);
    if (!cached) return false;
    try {
        const text = await decryptText(tab, cached.keyBytes);
        unlockedKeys.set(tab.id, cached.keyBytes);
        unlockedText.set(tab.id, text);
        const timer = setTimeout(() => lockTab(tab.id), Math.max(0, cached.expiresAt - Date.now()));
        lockTimers.set(tab.id, timer);
        return true;
    } catch (_error) {
        await clearUnlockKey(tab.id);
        return false;
    }
}

async function displayActiveTab() {
    const tab = getActiveTab();
    const available = await restoreCachedUnlock(tab);
    const locked = isEncryptedTab(tab) && !available;
    setLockedEditor(locked);
    if (!locked) {
        textarea.value = isEncryptedTab(tab) ? unlockedText.get(tab.id) : tab.text;
        updateTextNumber();
        updateLineNumbers();
        if (isEncryptedTab(tab)) await touchUnlock(tab);
    }
    renderTabs();
}

function renderTabs() {
    tabsContainer.replaceChildren();
    const normals = normalTabCount();
    state.tabs.forEach((tab) => {
        const wrapper = document.createElement('div');
        wrapper.className = `tab${tab.id === state.activeTabId ? ' active' : ''}${isInbox(tab) ? ' tab-inbox' : ''}`;

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'tab-select';
        if (isEncryptedTab(tab)) {
            const lockIcon = document.createElement('img');
            lockIcon.className = 'icon tab-icon';
            lockIcon.src = 'static/svgs/lock.svg';
            lockIcon.alt = '';
            lockIcon.setAttribute('aria-hidden', 'true');
            select.append(lockIcon);
        }
        const tabLabel = document.createElement('span');
        tabLabel.textContent = tab.name;
        select.append(tabLabel);
        select.title = tab.name;
        select.setAttribute('role', 'tab');
        select.setAttribute('aria-selected', String(tab.id === state.activeTabId));
        select.addEventListener('click', () => switchTab(tab.id));
        wrapper.append(select);
        tabsContainer.append(wrapper);
    });
    addTabButton.disabled = normalTabCount() >= MAX_USER_TABS;
    updateHeaderActions(normals);
}

function updateHeaderActions(normals = normalTabCount()) {
    const tab = getActiveTab();
    const reserved = isInbox(tab);
    headerActions.hidden = reserved;
    if (reserved) return;
    protectTabIcon.src = isEncryptedTab(tab) && !isUnlocked(tab)
        ? 'static/svgs/unlock.svg'
        : 'static/svgs/lock.svg';
    protectTabButton.title = isEncryptedTab(tab)
        ? (isUnlocked(tab) ? 'Password options' : 'Unlock tab')
        : 'Set password';
    protectTabButton.setAttribute('aria-label', protectTabButton.title);
    renameTabButton.title = `Rename ${tab.name}`;
    renameTabButton.setAttribute('aria-label', renameTabButton.title);
    deleteTabButton.title = `Delete ${tab.name}`;
    deleteTabButton.setAttribute('aria-label', deleteTabButton.title);
    deleteTabButton.disabled = normals === 1;
}

async function switchTab(tabId) {
    const target = state.tabs.find((tab) => tab.id === tabId);
    if (!target) return;
    if (tabId === state.activeTabId) {
        if (isEncryptedTab(target) && !isUnlocked(target)) await unlockTab(target.id);
        else if (isEncryptedTab(target)) await touchUnlock(target);
        return;
    }
    await flushEditor();
    state.activeTabId = tabId;
    await persistState();
    await displayActiveTab();
    if (isEncryptedTab(target) && !isUnlocked(target)) await unlockTab(target.id);
    else textarea.focus();
}

async function addTab() {
    if (normalTabCount() >= MAX_USER_TABS) return;
    await flushEditor();
    const tab = createPlainTab(`Tab ${normalTabCount() + 1}`);
    const inboxIndex = state.tabs.findIndex(isInbox);
    state.tabs.splice(inboxIndex, 0, tab);
    state.activeTabId = tab.id;
    await persistState();
    await displayActiveTab();
    await renameTab(tab.id);
}

async function renameTab(tabId) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || isInbox(tab)) return;
    const requestedName = await openModal({
        title: 'Rename tab',
        message: 'Enter a new name for this tab.',
        confirmLabel: 'Rename',
        input: { label: 'Tab name', value: tab.name },
        validate: (value) => value.trim() ? null : 'Tab name cannot be empty.'
    });
    if (requestedName === null) return;
    tab.name = requestedName.trim();
    if (isEncryptedTab(tab) && isUnlocked(tab)) await touchUnlock(tab);
    renderTabs();
    await persistState();
}

async function deleteTab(tabId) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || isInbox(tab) || normalTabCount() === 1) return;
    await flushEditor();
    const hasContent = isEncryptedTab(tab) || Boolean(tab.text);
    if (hasContent) {
        const confirmed = await openModal({
            title: 'Delete tab?',
            message: `“${tab.name}” contains saved text. This action cannot be undone.`,
            confirmLabel: 'Delete'
        });
        if (!confirmed) return;
    }
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    await clearUnlockKey(tab.id);
    unlockedKeys.delete(tab.id);
    unlockedText.delete(tab.id);
    clearTimeout(lockTimers.get(tab.id));
    if (state.activeTabId === tab.id) {
        state.activeTabId = state.tabs[Math.min(index, state.tabs.length - 1)].id;
    }
    await persistState();
    await displayActiveTab();
}

function passwordValidation(password, confirmation) {
    if (password.length < MIN_PASSWORD_LENGTH) return 'Password must contain at least 8 characters.';
    if (password !== confirmation) return 'Passwords do not match.';
    return null;
}

async function requestNewPassword(title, message) {
    return openModal({
        title,
        message,
        confirmLabel: 'Save password',
        input: { label: 'Password', type: 'password', autocomplete: 'new-password' },
        inputTwo: { label: 'Confirm password', type: 'password', autocomplete: 'new-password' },
        validate: passwordValidation
    });
}

async function setPassword(tabId) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || isInbox(tab) || isEncryptedTab(tab)) return;
    if (tab.id === state.activeTabId) await flushEditor();
    const result = await requestNewPassword('Protect tab', 'Encrypt this tab with a password. Forgotten passwords cannot be recovered.');
    if (!result) return;
    const [password] = result;
    const plaintext = tab.text;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyBytes = await deriveKeyBytes(password, salt);
    const payload = await encryptText(plaintext, tab.id, keyBytes, salt);
    delete tab.text;
    Object.assign(tab, { protected: true, ...payload });
    unlockedKeys.set(tab.id, keyBytes);
    unlockedText.set(tab.id, plaintext);
    await touchUnlock(tab);
    await persistState();
    await displayActiveTab();
}

async function unlockTab(tabId) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || !isEncryptedTab(tab)) return false;
    let derivedKey;
    let plaintext;
    const password = await openModal({
        title: 'Unlock tab',
        message: `Enter the password for “${tab.name}”.`,
        confirmLabel: 'Unlock',
        input: { label: 'Password', type: 'password', autocomplete: 'current-password' },
        validate: async (value) => {
            try {
                derivedKey = await deriveKeyBytes(value, base64ToBytes(tab.salt));
                plaintext = await decryptText(tab, derivedKey);
                return null;
            } catch (_error) {
                return 'Incorrect password or damaged encrypted data.';
            }
        }
    });
    if (password === null) return false;
    unlockedKeys.set(tab.id, derivedKey);
    unlockedText.set(tab.id, plaintext);
    await touchUnlock(tab);
    if (tab.id === state.activeTabId) await displayActiveTab();
    return true;
}

async function verifyCurrentPassword(tab, title) {
    let keyBytes;
    let plaintext;
    const result = await openModal({
        title,
        message: 'Enter the current password to continue.',
        confirmLabel: 'Continue',
        input: { label: 'Current password', type: 'password', autocomplete: 'current-password' },
        validate: async (value) => {
            try {
                keyBytes = await deriveKeyBytes(value, base64ToBytes(tab.salt));
                plaintext = await decryptText(tab, keyBytes);
                return null;
            } catch (_error) {
                return 'Incorrect password or damaged encrypted data.';
            }
        }
    });
    return result === null ? null : { keyBytes, plaintext };
}

async function changePassword(tab) {
    if (tab.id === state.activeTabId) await flushEditor();
    const verified = await verifyCurrentPassword(tab, 'Change password');
    if (!verified) return;
    const result = await requestNewPassword('Choose a new password', 'The tab will be re-encrypted immediately.');
    if (!result) return;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyBytes = await deriveKeyBytes(result[0], salt);
    Object.assign(tab, await encryptText(verified.plaintext, tab.id, keyBytes, salt));
    unlockedKeys.set(tab.id, keyBytes);
    unlockedText.set(tab.id, verified.plaintext);
    await touchUnlock(tab);
    await persistState();
    renderTabs();
}

async function removePassword(tab) {
    if (tab.id === state.activeTabId) await flushEditor();
    const verified = await verifyCurrentPassword(tab, 'Remove password');
    if (!verified) return;
    delete tab.salt;
    delete tab.iv;
    delete tab.ciphertext;
    Object.assign(tab, { protected: false, text: verified.plaintext });
    await clearUnlockKey(tab.id);
    unlockedKeys.delete(tab.id);
    unlockedText.delete(tab.id);
    clearTimeout(lockTimers.get(tab.id));
    await persistState();
    await displayActiveTab();
}

async function lockTab(tabId, clearSession = true) {
    const tab = state?.tabs.find((item) => item.id === tabId);
    if (!tab || !isEncryptedTab(tab) || !unlockedKeys.has(tab.id)) return;
    if (tab.id === state.activeTabId) await flushEditor();
    clearTimeout(lockTimers.get(tab.id));
    lockTimers.delete(tab.id);
    unlockedKeys.delete(tab.id);
    unlockedText.delete(tab.id);
    if (clearSession) await clearUnlockKey(tab.id);
    if (tab.id === state.activeTabId) await displayActiveTab();
    else renderTabs();
}

async function resetProtectedTab(tabId) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || !isEncryptedTab(tab)) return;
    const confirmed = await openModal({
        title: 'Reset protected tab?',
        message: `The encrypted content in “${tab.name}” will be permanently deleted. The password cannot be recovered.`,
        confirmLabel: 'Delete encrypted content'
    });
    if (!confirmed) return;
    delete tab.salt;
    delete tab.iv;
    delete tab.ciphertext;
    Object.assign(tab, { protected: false, text: '' });
    await clearUnlockKey(tab.id);
    unlockedKeys.delete(tab.id);
    unlockedText.delete(tab.id);
    clearTimeout(lockTimers.get(tab.id));
    await persistState();
    await displayActiveTab();
}

async function securityAction(tabId) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || isInbox(tab)) return;
    if (!isEncryptedTab(tab)) return setPassword(tab.id);
    if (!isUnlocked(tab)) return unlockTab(tab.id);
    await touchUnlock(tab);
    const choice = await openModal({
        title: 'Password options',
        message: `Manage protection for “${tab.name}”.`,
        options: [
            { label: 'Lock now', value: 'lock' },
            { label: 'Change password', value: 'change' },
            { label: 'Remove password', value: 'remove' }
        ]
    });
    if (choice === 'lock') await lockTab(tab.id);
    if (choice === 'change') await changePassword(tab);
    if (choice === 'remove') await removePassword(tab);
}

function closeOverflowMenu({ returnFocus = false } = {}) {
    if (overflowMenu.hidden) return;
    overflowMenu.hidden = true;
    overflowToggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) overflowToggle.focus();
}

function toggleOverflowMenu() {
    const opening = overflowMenu.hidden;
    overflowMenu.hidden = !opening;
    overflowToggle.setAttribute('aria-expanded', String(opening));
    if (opening) exportBackupButton.focus();
}

async function exportBackup() {
    closeOverflowMenu();
    await flushEditor();
    const backup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        state: structuredClone(state)
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `text-saver-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Backup exported');
}

function isValidBackup(backup) {
    return backup
        && backup.format === BACKUP_FORMAT
        && backup.version === BACKUP_VERSION
        && isValidState(backup.state);
}

async function clearRuntimeUnlocks(tabIds) {
    tabIds.forEach((tabId) => clearTimeout(lockTimers.get(tabId)));
    lockTimers.clear();
    unlockedKeys.clear();
    unlockedText.clear();
    await Promise.all([...tabIds].map((tabId) => clearUnlockKey(tabId)));
}

async function importBackupFile(file) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
        showToast('Backup is too large');
        return;
    }

    let backup;
    try {
        backup = JSON.parse(await file.text());
    } catch (_error) {
        showToast('Could not read this backup');
        return;
    }
    if (!isValidBackup(backup)) {
        showToast('Invalid or unsupported backup');
        return;
    }

    const importedTabs = backup.state.tabs.filter((tab) => !isInbox(tab));
    const choice = await openModal({
        title: 'Import backup',
        message: `This backup contains ${importedTabs.length} saved ${importedTabs.length === 1 ? 'tab' : 'tabs'}. Merge it with this device or replace all current tabs.`,
        options: [
            { label: 'Merge with current tabs', value: 'merge' },
            { label: 'Replace current tabs', value: 'replace' }
        ]
    });
    if (!choice) return;

    await flushEditor();
    let nextState;
    let importedCount = importedTabs.length;
    if (choice === 'replace') {
        nextState = structuredClone(backup.state);
    } else {
        const existingIds = new Set(state.tabs.map((tab) => tab.id));
        const availableSlots = MAX_USER_TABS - normalTabCount();
        const additions = importedTabs
            .filter((tab) => !existingIds.has(tab.id))
            .slice(0, availableSlots)
            .map((tab) => structuredClone(tab));
        importedCount = additions.length;
        if (!importedCount) {
            showToast(availableSlots ? 'These tabs are already imported' : 'Tab limit reached');
            return;
        }
        nextState = structuredClone(state);
        const inboxIndex = nextState.tabs.findIndex(isInbox);
        nextState.tabs.splice(inboxIndex, 0, ...additions);
    }

    const affectedIds = new Set([
        ...state.tabs.map((tab) => tab.id),
        ...nextState.tabs.map((tab) => tab.id)
    ]);
    await clearRuntimeUnlocks(affectedIds);
    state = nextState;
    textEditPending = false;
    await persistState();
    await displayActiveTab();
    showToast(choice === 'replace' ? 'Backup restored' : `${importedCount} ${importedCount === 1 ? 'tab' : 'tabs'} imported`);
}

async function copyText(text, successMessage) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(successMessage);
    } catch (_error) {
        const fallback = document.createElement('textarea');
        fallback.value = text;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.append(fallback);
        fallback.select();
        const copied = document.execCommand('copy');
        fallback.remove();
        if (copied) showToast(successMessage);
    }
}

async function copyLine(text, lineIndex) {
    const tab = getActiveTab();
    if (isEncryptedTab(tab) && !isUnlocked(tab)) return;
    if (isEncryptedTab(tab)) await touchUnlock(tab);
    await copyText(text, `Line ${lineIndex} copied to clipboard`);
}

async function copyActiveText() {
    const tab = getActiveTab();
    if (isEncryptedTab(tab) && !isUnlocked(tab)) return;
    if (isEncryptedTab(tab)) await touchUnlock(tab);
    await copyText(textarea.value, 'Copied to clipboard');
}

async function downloadActiveText() {
    const tab = getActiveTab();
    if (isEncryptedTab(tab) && !isUnlocked(tab)) return;
    if (isEncryptedTab(tab)) await touchUnlock(tab);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const now = new Date();
    const filename = `Text Saver - ${months[now.getMonth()]} ${now.getDate()} ${now.getFullYear()}.txt`;
    const blob = new Blob([textarea.value.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

textarea.addEventListener('beforeinput', (event) => {
    if (!event.inputType.startsWith('insert')) return;
    let insertedText = event.dataTransfer?.getData('text/plain');
    if (insertedText === undefined || insertedText === null) insertedText = event.data;
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') insertedText = '\n';
    if (typeof insertedText !== 'string') return;
    const limitMessage = insertionLimitMessage(insertedText);
    if (!limitMessage) return;
    event.preventDefault();
    showToast(limitMessage);
});
textarea.addEventListener('paste', (event) => {
    const pastedText = event.clipboardData?.getData('text/plain');
    if (typeof pastedText !== 'string') return;
    const limitMessage = insertionLimitMessage(pastedText);
    if (!limitMessage) return;
    event.preventDefault();
    showToast(limitMessage);
});
textarea.addEventListener('input', () => {
    const tab = getActiveTab();
    if (isEncryptedTab(tab)) {
        unlockedText.set(tab.id, textarea.value);
        touchUnlock(tab).catch(console.error);
    } else {
        tab.text = textarea.value;
    }
    textEditPending = true;
    saveRevision += 1;
    setSaveStatus('saving');
    updateTextNumber();
    updateLineNumbers();
    scheduleSave();
});
textarea.addEventListener('scroll', () => { lineNumbers.scrollTop = textarea.scrollTop; });
addTabButton.addEventListener('click', addTab);
copyButton.addEventListener('click', copyActiveText);
saveButton.addEventListener('click', downloadActiveText);
themeToggle.addEventListener('click', toggleTheme);
protectTabButton.addEventListener('click', () => securityAction(getActiveTab().id));
renameTabButton.addEventListener('click', () => renameTab(getActiveTab().id));
deleteTabButton.addEventListener('click', () => deleteTab(getActiveTab().id));
overflowToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleOverflowMenu();
});
overflowMenu.addEventListener('click', (event) => event.stopPropagation());
exportBackupButton.addEventListener('click', () => exportBackup().catch((error) => {
    console.error('Text Saver could not export the backup.', error);
    showToast('Export failed');
}));
importBackupButton.addEventListener('click', () => {
    closeOverflowMenu();
    backupFileInput.click();
});
backupFileInput.addEventListener('change', () => {
    const [file] = backupFileInput.files;
    backupFileInput.value = '';
    importBackupFile(file).catch((error) => {
        console.error('Text Saver could not import the backup.', error);
        showToast('Import failed');
    });
});
document.addEventListener('click', () => closeOverflowMenu());
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overflowMenu.hidden) {
        event.preventDefault();
        closeOverflowMenu({ returnFocus: true });
    }
});
unlockTabButton.addEventListener('click', () => unlockTab(getActiveTab().id));
resetTabButton.addEventListener('click', () => resetProtectedTab(getActiveTab().id));
window.addEventListener('blur', () => flushEditor().catch(console.error));
window.addEventListener('pagehide', () => flushEditor().catch(console.error));

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') return;
    Object.entries(changes).forEach(([key, change]) => {
        if (!key.startsWith(UNLOCK_PREFIX) || change.newValue !== undefined) return;
        const tabId = key.slice(UNLOCK_PREFIX.length);
        lockTab(tabId, false).catch(console.error);
    });
});

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadTheme();
        state = await getOrMigrateState();
        await displayActiveTab();
        textarea.scrollTop = textarea.scrollHeight;
        document.fonts?.ready.then(() => updateLineNumbers());
    } catch (error) {
        console.error('Text Saver could not load saved data.', error);
        setSaveStatus('error');
        textarea.disabled = true;
    }
});
