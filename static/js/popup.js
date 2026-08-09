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
    saveState
} from './storage.js';

const AUTOSAVE_DELAY = 300;
const MIN_PASSWORD_LENGTH = 8;

const textarea = document.getElementById('formats');
const tabsContainer = document.getElementById('tabs');
const addTabButton = document.getElementById('add-tab');
const textNumber = document.getElementById('text-number');
const copyButton = document.getElementById('copy');
const saveButton = document.getElementById('save');
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

let state;
let saveTimer;
let saveQueue = Promise.resolve();
let modalResolver;
let modalConfig;
let modalReturnFocus;
const unlockedKeys = new Map();
const unlockedText = new Map();
const lockTimers = new Map();

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
    textNumber.textContent = textarea.value.length.toLocaleString('en-US');
}

function updateLineNumbers() {
    const lineCount = textarea.value.split('\n').length;
    lineNumbers.textContent = Array.from({ length: lineCount }, (_value, index) => index + 1).join('\n');
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

function persistState() {
    clearTimeout(saveTimer);
    const snapshot = structuredClone(state);
    saveQueue = saveQueue.catch(() => undefined).then(() => saveState(snapshot));
    return saveQueue;
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
    if (isEncryptedTab(tab)) {
        const keyBytes = unlockedKeys.get(tab.id);
        const payload = await encryptText(textarea.value, tab.id, keyBytes, base64ToBytes(tab.salt));
        Object.assign(tab, payload);
        unlockedText.set(tab.id, textarea.value);
    } else {
        tab.text = textarea.value;
    }
    return persistState();
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
        select.textContent = `${isEncryptedTab(tab) ? '🔒 ' : ''}${tab.name}`;
        select.title = tab.name;
        select.setAttribute('role', 'tab');
        select.setAttribute('aria-selected', String(tab.id === state.activeTabId));
        select.addEventListener('click', () => switchTab(tab.id));
        if (!isInbox(tab)) select.addEventListener('dblclick', () => renameTab(tab.id));
        wrapper.append(select);

        if (!isInbox(tab)) {
            const security = document.createElement('button');
            security.type = 'button';
            security.className = 'tab-action';
            security.textContent = isEncryptedTab(tab) ? (isUnlocked(tab) ? '●' : '○') : '◇';
            security.title = isEncryptedTab(tab)
                ? (isUnlocked(tab) ? 'Password options' : 'Unlock tab')
                : 'Set password';
            security.setAttribute('aria-label', security.title);
            security.addEventListener('click', () => securityAction(tab.id));

            const rename = document.createElement('button');
            rename.type = 'button';
            rename.className = 'tab-action';
            rename.textContent = '✎';
            rename.title = `Rename ${tab.name}`;
            rename.setAttribute('aria-label', rename.title);
            rename.addEventListener('click', () => renameTab(tab.id));

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'tab-action';
            remove.textContent = '×';
            remove.title = `Delete ${tab.name}`;
            remove.setAttribute('aria-label', remove.title);
            remove.disabled = normals === 1;
            remove.addEventListener('click', () => deleteTab(tab.id));
            wrapper.append(security, rename, remove);
        }
        tabsContainer.append(wrapper);
    });
    addTabButton.disabled = normalTabCount() >= MAX_USER_TABS;
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

async function copyActiveText() {
    const tab = getActiveTab();
    if (isEncryptedTab(tab) && !isUnlocked(tab)) return;
    if (isEncryptedTab(tab)) await touchUnlock(tab);
    try {
        await navigator.clipboard.writeText(textarea.value);
    } catch (_error) {
        textarea.select();
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
    }
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

textarea.addEventListener('input', () => {
    const tab = getActiveTab();
    if (isEncryptedTab(tab)) {
        unlockedText.set(tab.id, textarea.value);
        touchUnlock(tab).catch(console.error);
    } else {
        tab.text = textarea.value;
    }
    updateTextNumber();
    updateLineNumbers();
    scheduleSave();
});
textarea.addEventListener('scroll', () => { lineNumbers.scrollTop = textarea.scrollTop; });
addTabButton.addEventListener('click', addTab);
copyButton.addEventListener('click', copyActiveText);
saveButton.addEventListener('click', downloadActiveText);
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
        state = await getOrMigrateState();
        await displayActiveTab();
        textarea.scrollTop = textarea.scrollHeight;
    } catch (error) {
        console.error('Text Saver could not load saved data.', error);
        textarea.disabled = true;
    }
});
