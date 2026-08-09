import {
    ALARM_PREFIX,
    INBOX_ID,
    UNLOCK_PREFIX,
    getOrMigrateState,
    saveState
} from './static/js/storage.js';

chrome.runtime.onInstalled.addListener(async () => {
    try {
        await getOrMigrateState();
    } catch (error) {
        console.error('Text Saver could not migrate saved data.', error);
    }

    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
        id: 'text-saver-highlight-text',
        title: 'Save selected text to Context Menu inbox',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId !== 'text-saver-highlight-text') return;
    try {
        const state = await getOrMigrateState();
        const inbox = state.tabs.find((tab) => tab.id === INBOX_ID);
        if (!inbox) throw new Error('Context Menu inbox is missing.');
        const selectedText = typeof info.selectionText === 'string' ? info.selectionText : '';
        inbox.text = `${selectedText}\n\n${inbox.text}`;
        await saveState(state);
    } catch (error) {
        console.error('Text Saver could not save selected text.', error);
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const tabId = alarm.name.slice(ALARM_PREFIX.length);
    await chrome.storage.session.remove(`${UNLOCK_PREFIX}${tabId}`);
});
