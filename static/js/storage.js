export const STATE_KEY = 'text_saver_state';
export const LEGACY_KEY = 'text_saver';
export const SCHEMA_VERSION = 2;
export const MAX_USER_TABS = 10;
export const INBOX_ID = 'context-menu-inbox';
export const UNLOCK_PREFIX = 'text_saver_unlock_';
export const ALARM_PREFIX = 'text-saver-lock-';
export const UNLOCK_MS = 2 * 60 * 1000;
export const PBKDF2_ITERATIONS = 600000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createId() {
    return globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createPlainTab(name, text = '', kind = 'normal') {
    return { id: kind === 'inbox' ? INBOX_ID : createId(), name, kind, protected: false, text };
}

export function createInbox() {
    return createPlainTab('Context Menu', '', 'inbox');
}

export function isInbox(tab) {
    return tab?.kind === 'inbox';
}

export function isEncryptedTab(tab) {
    return tab?.protected === true;
}

function isBase64(value) {
    return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function isValidTab(tab) {
    if (!tab || typeof tab.id !== 'string' || typeof tab.name !== 'string') return false;
    if (tab.kind !== 'normal' && tab.kind !== 'inbox') return false;
    if (tab.kind === 'inbox') {
        return tab.id === INBOX_ID && tab.protected === false && typeof tab.text === 'string';
    }
    if (tab.protected === false) return typeof tab.text === 'string';
    return tab.protected === true
        && isBase64(tab.salt)
        && isBase64(tab.iv)
        && isBase64(tab.ciphertext);
}

export function isValidState(value) {
    if (!value || value.version !== SCHEMA_VERSION || !Array.isArray(value.tabs)) return false;
    if (!value.tabs.length || !value.tabs.every(isValidTab)) return false;
    if (value.tabs.filter((tab) => tab.kind === 'normal').length > MAX_USER_TABS) return false;
    if (value.tabs.filter(isInbox).length !== 1) return false;
    return typeof value.activeTabId === 'string'
        && value.tabs.some((tab) => tab.id === value.activeTabId);
}

function isVersionOneState(value) {
    return value
        && value.version === 1
        && Array.isArray(value.tabs)
        && value.tabs.length > 0
        && value.tabs.length <= MAX_USER_TABS
        && value.tabs.every((tab) => tab
            && typeof tab.id === 'string'
            && typeof tab.name === 'string'
            && typeof tab.text === 'string');
}

function migrateVersionOne(value) {
    const tabs = value.tabs.map((tab, index) => ({
        id: tab.id,
        name: tab.name.trim() || `Tab ${index + 1}`,
        kind: 'normal',
        protected: false,
        text: tab.text
    }));
    tabs.push(createInbox());
    return {
        version: SCHEMA_VERSION,
        tabs,
        activeTabId: tabs.some((tab) => tab.id === value.activeTabId)
            ? value.activeTabId
            : tabs[0].id
    };
}

export async function getOrMigrateState(storage = chrome.storage.local) {
    const stored = await storage.get([STATE_KEY, LEGACY_KEY]);
    const existing = stored[STATE_KEY];
    if (isValidState(existing)) return structuredClone(existing);
    if (existing !== undefined && !isVersionOneState(existing)) {
        throw new Error('Saved Text Saver data has an unsupported or malformed schema.');
    }

    let state;
    if (isVersionOneState(existing)) {
        state = migrateVersionOne(existing);
    } else {
        const legacyText = typeof stored[LEGACY_KEY] === 'string' ? stored[LEGACY_KEY] : '';
        const firstTab = createPlainTab('Tab 1', legacyText);
        state = {
            version: SCHEMA_VERSION,
            tabs: [firstTab, createInbox()],
            activeTabId: firstTab.id
        };
    }

    await storage.set({ [STATE_KEY]: state });
    await storage.remove(LEGACY_KEY);
    return structuredClone(state);
}

export async function saveState(state, storage = chrome.storage.local) {
    if (!isValidState(state)) throw new Error('Refusing to save invalid Text Saver data.');
    await storage.set({ [STATE_KEY]: state });
}

export function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

export function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

export async function deriveKeyBytes(password, salt) {
    const material = await crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
    }, material, 256);
    return new Uint8Array(bits);
}

async function importAesKey(keyBytes) {
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function additionalData(tabId) {
    return encoder.encode(`text-saver:v${SCHEMA_VERSION}:${tabId}`);
}

export async function encryptText(text, tabId, keyBytes, saltBytes) {
    const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await importAesKey(keyBytes);
    const ciphertext = await crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv,
        additionalData: additionalData(tabId),
        tagLength: 128
    }, key, encoder.encode(text));
    return {
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
}

export async function decryptText(tab, keyBytes) {
    const key = await importAesKey(keyBytes);
    const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: base64ToBytes(tab.iv),
        additionalData: additionalData(tab.id),
        tagLength: 128
    }, key, base64ToBytes(tab.ciphertext));
    return decoder.decode(plaintext);
}

export async function cacheUnlockKey(tabId, keyBytes, expiresAt = Date.now() + UNLOCK_MS) {
    await chrome.storage.session.set({
        [`${UNLOCK_PREFIX}${tabId}`]: { key: bytesToBase64(keyBytes), expiresAt }
    });
    await chrome.alarms.create(`${ALARM_PREFIX}${tabId}`, { when: expiresAt });
    return expiresAt;
}

export async function getCachedUnlockKey(tabId) {
    const storageKey = `${UNLOCK_PREFIX}${tabId}`;
    const stored = await chrome.storage.session.get(storageKey);
    const record = stored[storageKey];
    if (!record || typeof record.key !== 'string' || record.expiresAt <= Date.now()) {
        await clearUnlockKey(tabId);
        return null;
    }
    return { keyBytes: base64ToBytes(record.key), expiresAt: record.expiresAt };
}

export async function clearUnlockKey(tabId) {
    await chrome.storage.session.remove(`${UNLOCK_PREFIX}${tabId}`);
    await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
}
