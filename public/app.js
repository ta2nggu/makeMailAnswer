// State Management
let selectedEmail = null;
let emailsList = [];
let currentPage = 1;
let totalMailCount = 0;
let serverTotalCount = 0;
let currentMaxCacheSize = 500;
const limitPerPage = 10;
let isLoadingMore = false;
let searchQuery = '';
let searchDebounceTimeout = null;
let chatHistory = [];
let isComposingNewMail = false;

// Prompt Tuning State
let defaultEmailPromptTemplate = '';
let defaultNewEmailPromptTemplate = '';
let defaultMessengerPromptTemplate = '';
let currentReplyMode = 'reply'; // 'reply' or 'reply-all'

// Attachments & Inline Images State (for Reply & New Mail)
let replyAttachments = []; // [{ filename, data, size, contentType }]
let replyInlineImages = []; // [{ cid, filename, data, size, contentType }]

let composeAttachments = []; // [{ filename, data, size, contentType }]
let composeInlineImages = []; // [{ cid, filename, data, size, contentType }]

function debounceSearch(callback, delay = 400) {
  return function(...args) {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => callback.apply(this, args), delay);
  };
}

// Parse multiple email addresses into array of { name, email }
function parseEmailList(str) {
  if (!str) return [];
  const results = [];
  const regex = /(?:"?([^"]*)"?\s*)?<([^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const email = (match[2] || match[3] || '').trim();
    const name = (match[1] || '').trim();
    if (email) {
      results.push({ name, email });
    }
  }
  return results;
}

// Initialize Icons & Apps
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  fetchEmails(false); // Auto fetch page 1 on load
  initSplitPane(); // Activate resizable splitter
  loadDefaultPrompts(); // Load default prompt templates
  
  // Bind Reply / Reply-All Switcher Buttons
  const btnModeReply = document.getElementById('btn-mode-reply');
  const btnModeReplyAll = document.getElementById('btn-mode-reply-all');
  if (btnModeReply && btnModeReplyAll) {
    btnModeReply.addEventListener('click', () => setReplyMode('reply'));
    btnModeReplyAll.addEventListener('click', () => setReplyMode('reply-all'));
  }

  // Bind Event Listeners
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      const currentIcon = document.getElementById('refresh-icon');
      if (currentIcon) {
        currentIcon.classList.remove('spin-once');
        void currentIcon.offsetWidth; // Force reflow to restart animation if clicked repeatedly
        currentIcon.classList.add('spin-once');
        currentIcon.addEventListener('animationend', () => {
          currentIcon.classList.remove('spin-once');
        }, { once: true });
      }
      fetchEmails(false, true);
    });
  }
  const btnWelcomeRefresh = document.getElementById('btn-welcome-refresh');
  if (btnWelcomeRefresh) {
    btnWelcomeRefresh.addEventListener('click', () => fetchEmails(false));
  }

  // Bind Compose (New Email) Buttons
  const btnOpenCompose = document.getElementById('btn-open-compose');
  if (btnOpenCompose) {
    btnOpenCompose.addEventListener('click', openNewMailCompose);
  }
  const btnWelcomeCompose = document.getElementById('btn-welcome-compose');
  if (btnWelcomeCompose) {
    btnWelcomeCompose.addEventListener('click', openNewMailCompose);
  }

  const btnGenerate = document.getElementById('btn-generate');
  if (btnGenerate) {
    btnGenerate.addEventListener('click', generateAIDraft);
  }
  const btnCopy = document.getElementById('btn-copy');
  if (btnCopy) {
    btnCopy.addEventListener('click', copyDraftToClipboard);
  }
  const btnSendMail = document.getElementById('btn-send-mail');
  if (btnSendMail) {
    btnSendMail.addEventListener('click', sendReplyEmail);
  }

  // Bind New Mail Actions
  const btnGenerateNewMail = document.getElementById('btn-generate-newmail');
  if (btnGenerateNewMail) {
    btnGenerateNewMail.addEventListener('click', generateNewMailAIDraft);
  }
  const btnCopyNewMail = document.getElementById('btn-copy-newmail');
  if (btnCopyNewMail) {
    btnCopyNewMail.addEventListener('click', copyNewMailDraftToClipboard);
  }
  const btnSendNewMail = document.getElementById('btn-send-newmail');
  if (btnSendNewMail) {
    btnSendNewMail.addEventListener('click', sendNewMailEmail);
  }

  // Bind Reply Guide Live Input Update for Email Prompt Editor
  const replyGuideInput = document.getElementById('reply-guide');
  if (replyGuideInput) {
    replyGuideInput.addEventListener('input', updateEmailPromptEditor);
  }

  // Bind New Mail Live Inputs Update for New Mail Prompt Editor
  const composeRecipientInput = document.getElementById('compose-recipient-info');
  const composeSubjectHintInput = document.getElementById('compose-subject-hint');
  const composeContentGuideInput = document.getElementById('compose-content-guide');
  if (composeRecipientInput) {
    composeRecipientInput.addEventListener('input', updateNewEmailPromptEditor);
  }
  if (composeSubjectHintInput) {
    composeSubjectHintInput.addEventListener('input', updateNewEmailPromptEditor);
  }
  if (composeContentGuideInput) {
    composeContentGuideInput.addEventListener('input', updateNewEmailPromptEditor);
  }

  // Bind Messenger Live Inputs Update for Messenger Prompt Editor
  const messengerChatInput = document.getElementById('messenger-chat-history');
  const messengerKeywordsInput = document.getElementById('messenger-keywords');
  if (messengerChatInput) {
    messengerChatInput.addEventListener('input', updateMessengerPromptEditor);
  }
  if (messengerKeywordsInput) {
    messengerKeywordsInput.addEventListener('input', updateMessengerPromptEditor);
  }

  // Bind Prompt Tuning Toggle Accordions
  initPromptTuningUI();

  // Bind Search Events
  const searchInput = document.getElementById('search-input');
  const btnClearSearch = document.getElementById('btn-clear-search');

  if (searchInput) {
    searchInput.addEventListener('input', debounceSearch((e) => {
      searchQuery = e.target.value.trim();
      if (searchQuery) {
        if (btnClearSearch) btnClearSearch.classList.remove('hidden');
      } else {
        if (btnClearSearch) btnClearSearch.classList.add('hidden');
      }
      fetchEmails(false);
    }, 400));
  }

  if (btnClearSearch && searchInput) {
    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      btnClearSearch.classList.add('hidden');
      fetchEmails(false);
      searchInput.focus();
    });
  }

  // Bind Tab Click Events
  const tabReply = document.getElementById('tab-reply');
  const tabChat = document.getElementById('tab-chat');
  const panelReply = document.getElementById('panel-reply');
  const panelChat = document.getElementById('panel-chat');

  if (tabReply && tabChat && panelReply && panelChat) {
    tabReply.addEventListener('click', () => {
      tabReply.classList.add('active');
      tabChat.classList.remove('active');
      panelReply.classList.remove('hidden');
      panelChat.classList.add('hidden');
    });

    tabChat.addEventListener('click', () => {
      tabChat.classList.add('active');
      tabReply.classList.remove('active');
      panelChat.classList.remove('hidden');
      panelReply.classList.add('hidden');
      // Scroll chat to bottom when switching tab
      const chatMessages = document.getElementById('chat-messages');
      if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    });
  }

  // Bind Chat Input Send Events
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');

  if (btnChatSend) {
    btnChatSend.addEventListener('click', sendChatMessage);
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  // Bind Workspace Mode Toggle (Email vs Messenger)
  const modeMailBtn = document.getElementById('mode-mail');
  const modeMessengerBtn = document.getElementById('mode-messenger');
  if (modeMailBtn && modeMessengerBtn) {
    modeMailBtn.addEventListener('click', () => switchWorkspaceMode('mail'));
    modeMessengerBtn.addEventListener('click', () => switchWorkspaceMode('messenger'));
  }

  // Bind Messenger Advice Generation
  const btnGenerateMessenger = document.getElementById('btn-generate-messenger');
  if (btnGenerateMessenger) {
    btnGenerateMessenger.addEventListener('click', generateMessengerAdvice);
  }

  // Bind Top Sync Control Bar Events
  const btnTopLoadMore = document.getElementById('btn-top-load-more');
  const selectFetchLimit = document.getElementById('select-fetch-limit');
  const btnMarkAllRead = document.getElementById('btn-mark-all-read');
  if (btnTopLoadMore) {
    btnTopLoadMore.addEventListener('click', () => loadMoreFromServer({ amount: 500 }));
  }
  if (selectFetchLimit) {
    selectFetchLimit.addEventListener('change', (e) => {
      const val = e.target.value;
      loadMoreFromServer({ targetSize: val });
    });
  }
  if (btnMarkAllRead) {
    btnMarkAllRead.addEventListener('click', markAllMailsAsRead);
  }

  // Auto refresh every 30 minutes (30 * 60 * 1000 ms)
  const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
  setInterval(() => {
    const refreshBtn = document.getElementById('btn-refresh');
    if (refreshBtn && !refreshBtn.disabled) {
      console.log('[Auto-Refresh] 30분 주기 메일 자동 새로고침 실행');
      refreshBtn.click();
    }
  }, AUTO_REFRESH_INTERVAL_MS);

  // Initialize Clipboard Image Pasting and File Attachments
  initAttachmentAndPasteHandlers();
});

// Resizable Split Pane Logic
function initSplitPane() {
  const panel = document.getElementById('workspace-panel');
  const resizer = document.getElementById('workspace-resizer');
  
  if (!resizer || !panel) return;
  
  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // Prevent text selection
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const panelRect = panel.getBoundingClientRect();
    const relativeX = e.clientX - panelRect.left;
    
    // Calculate percentage and constrain between 25% and 75% for safety
    let percent = (relativeX / panelRect.width) * 100;
    if (percent < 25) percent = 25;
    if (percent > 75) percent = 75;
    
    panel.style.gridTemplateColumns = `${percent}% 6px ${100 - percent}%`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    }
  });
}

// Toast System Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle';
  if (type === 'error') iconName = 'alert-triangle';

  toast.innerHTML = `
    <i data-lucide="${iconName}" class="toast-icon"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  lucide.createIcons({ attrs: { class: 'toast-icon' } });

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Fetch Email List (with Pagination support)
async function fetchEmails(append = false, forceRefresh = false) {
  const refreshBtn = document.getElementById('btn-refresh');
  const refreshIcon = document.getElementById('refresh-icon');
  const mailListContainer = document.getElementById('mail-list');

  if (append) {
    isLoadingMore = true;
    const loadMoreBtn = document.getElementById('btn-load-more') || document.getElementById('btn-load-more-server');
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.innerHTML = `<div class="spinner" style="width:14px; height:14px; border-width:2px;"></div> 불러오는 중...`;
    }
  } else {
    // Reset paging state on manual refresh or welcome reload
    currentPage = 1;
    emailsList = [];
    if (refreshBtn) refreshBtn.disabled = true;

    const loadingMessage = searchQuery ? '메일을 검색하는 중...' : 'KT Biz Office 사서함을 읽는 중...';
    mailListContainer.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>${loadingMessage}</p>
      </div>
    `;
  }

  try {
    let url = `/api/emails?page=${currentPage}&limit=${limitPerPage}`;
    if (searchQuery) {
      url += `&search=${encodeURIComponent(searchQuery)}`;
    }
    if (forceRefresh) {
      url += `&forceRefresh=true`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '알 수 없는 서버 에러가 발생했습니다.');
    }

    totalMailCount = data.count || 0;
    serverTotalCount = data.serverTotalCount || totalMailCount;
    currentMaxCacheSize = data.maxCacheSize || 500;
    const newEmails = data.emails || [];

    if (append) {
      emailsList = emailsList.concat(newEmails);
    } else {
      emailsList = newEmails;
    }

    // Update Top Sync Bar Status Text & Select Dropdown
    updateTopSyncBar();

    renderMailList(emailsList);
    
    // Refresh icons inside rendered content
    lucide.createIcons();
    
    if (append) {
      showToast(`이전 메일 ${newEmails.length}개를 추가로 불러왔습니다.`, 'success');
    } else {
      if (searchQuery) {
        showToast(`검색 조건에 맞는 메일을 ${totalMailCount}개 찾았습니다.`, 'success');
      } else {
        showToast(`성공적으로 메일 목록을 가져왔습니다. (총 ${totalMailCount}개 / 서버 ${serverTotalCount}개)`, 'success');
      }
    }
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
    if (!append) {
      mailListContainer.innerHTML = `
        <div class="loading-state">
          <i data-lucide="alert-circle" style="color: var(--accent-danger)"></i>
          <p style="margin-top: 0.5rem">불러오기 실패</p>
          <small style="color: var(--text-muted); text-align: center; max-width: 200px;">${error.message}</small>
        </div>
      `;
      lucide.createIcons();
    }
  } finally {
    isLoadingMore = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

// Update Top Sync Control Bar Display
function updateTopSyncBar() {
  const syncStatusText = document.getElementById('sync-status-text');
  const selectFetchLimit = document.getElementById('select-fetch-limit');

  if (syncStatusText) {
    if (searchQuery) {
      syncStatusText.textContent = `검색: ${totalMailCount}개 (서버 ${serverTotalCount}개)`;
    } else {
      syncStatusText.textContent = `동기화: ${totalMailCount}개 / 서버 ${serverTotalCount > 0 ? serverTotalCount + '개' : '--개'}`;
    }
  }

  if (selectFetchLimit) {
    // Check if select has exact matching value
    const match = Array.from(selectFetchLimit.options).find(opt => opt.value === String(currentMaxCacheSize));
    if (match) {
      selectFetchLimit.value = String(currentMaxCacheSize);
    }
  }
}

// Fetch more emails from server (supports amount or targetSize)
async function loadMoreFromServer(options = { amount: 500 }) {
  const btnTop = document.getElementById('btn-top-load-more');
  const btnBottom = document.getElementById('btn-load-more-server');
  const selectFetchLimit = document.getElementById('select-fetch-limit');

  if (btnTop) btnTop.disabled = true;
  if (btnBottom) btnBottom.disabled = true;

  try {
    const targetLabel = options.targetSize === 'all' ? '전체' : (options.targetSize ? `${options.targetSize}개` : `${options.amount || 500}개`);
    showToast(`메일 서버에서 ${targetLabel} 메일을 동기화하고 있습니다...`, 'info');

    const response = await fetch('/api/emails/load-more-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '서버 동기화에 실패했습니다.');
    }

    currentMaxCacheSize = data.maxCacheSize;
    serverTotalCount = data.serverTotalCount;
    showToast(`메일 한도가 ${data.maxCacheSize}개로 확장되었습니다. 메일을 불러옵니다.`, 'success');

    // Reload emails from page 1 or append
    await fetchEmails(false, true);
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  } finally {
    if (btnTop) btnTop.disabled = false;
    if (btnBottom) btnBottom.disabled = false;
  }
}

// Read & Reply Status Management (Stored in localStorage)
function getReadMailKeys() {
  try {
    return new Set(JSON.parse(localStorage.getItem('mail_read_keys') || '[]'));
  } catch (e) {
    return new Set();
  }
}

function getRepliedMailKeys() {
  try {
    return new Set(JSON.parse(localStorage.getItem('mail_replied_keys') || '[]'));
  } catch (e) {
    return new Set();
  }
}

function getMailKey(email) {
  if (!email) return '';
  return email.uniqueId || String(email.id);
}

function markMailAsRead(email) {
  const key = getMailKey(email);
  if (!key) return;
  const readSet = getReadMailKeys();
  if (!readSet.has(key)) {
    readSet.add(key);
    try {
      localStorage.setItem('mail_read_keys', JSON.stringify(Array.from(readSet)));
    } catch (e) {
      console.warn('Failed to save read status to localStorage', e);
    }
  }
  updateMailItemStatusUI(key, true, null);
}

function markAllMailsAsRead() {
  if (!emailsList || emailsList.length === 0) {
    showToast('읽음 처리할 메일이 없습니다.', 'info');
    return;
  }
  const readSet = getReadMailKeys();
  let addedCount = 0;
  emailsList.forEach(email => {
    const key = getMailKey(email);
    if (key && !readSet.has(key)) {
      readSet.add(key);
      addedCount++;
    }
  });

  try {
    localStorage.setItem('mail_read_keys', JSON.stringify(Array.from(readSet)));
  } catch (e) {
    console.warn('Failed to save read status to localStorage', e);
  }

  // Update UI for all mail items in DOM
  document.querySelectorAll('.mail-item').forEach(item => {
    item.classList.add('read');
    item.classList.remove('unread');
    const readBadge = item.querySelector('.mail-status-read');
    if (readBadge) {
      readBadge.className = 'mail-status-badge mail-status-read is-read';
      readBadge.title = '읽음';
      readBadge.innerHTML = '<i data-lucide="mail-open"></i>';
    }
  });
  lucide.createIcons();
  showToast(`메일 ${emailsList.length}개를 모두 읽음 처리했습니다.`, 'success');
}

function markMailAsReplied(email) {
  const key = getMailKey(email);
  if (!key) return;
  const repliedSet = getRepliedMailKeys();
  if (!repliedSet.has(key)) {
    repliedSet.add(key);
    try {
      localStorage.setItem('mail_replied_keys', JSON.stringify(Array.from(repliedSet)));
    } catch (e) {
      console.warn('Failed to save replied status to localStorage', e);
    }
  }
  updateMailItemStatusUI(key, null, true);
}

function updateMailItemStatusUI(mailKey, isRead, isReplied) {
  let item = document.querySelector(`.mail-item[data-key="${mailKey}"]`);
  if (!item) {
    item = document.querySelector(`.mail-item[data-id="${mailKey}"]`);
  }
  if (!item) return;

  if (isRead !== null) {
    if (isRead) {
      item.classList.add('read');
      item.classList.remove('unread');
      const readBadge = item.querySelector('.mail-status-read');
      if (readBadge) {
        readBadge.className = 'mail-status-badge mail-status-read is-read';
        readBadge.title = '읽음';
        readBadge.innerHTML = '<i data-lucide="mail-open"></i>';
      }
    }
  }

  if (isReplied !== null) {
    if (isReplied) {
      item.classList.add('replied');
      let repliedBadge = item.querySelector('.mail-status-replied');
      if (!repliedBadge) {
        const badgesContainer = item.querySelector('.mail-status-badges');
        if (badgesContainer) {
          repliedBadge = document.createElement('span');
          repliedBadge.className = 'mail-status-badge mail-status-replied is-replied';
          repliedBadge.title = '회신 완료';
          repliedBadge.innerHTML = '<i data-lucide="corner-up-left"></i>';
          badgesContainer.prepend(repliedBadge);
        }
      }
    }
  }
  lucide.createIcons();
}

// Render Emails to Sidebar
function renderMailList(emails) {
  const mailListContainer = document.getElementById('mail-list');
  mailListContainer.innerHTML = '';

  if (emails.length === 0) {
    mailListContainer.innerHTML = `
      <div class="loading-state">
        <i data-lucide="inbox" style="color: var(--text-muted)"></i>
        <p>받은 메일함이 비어 있습니다.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const readSet = getReadMailKeys();
  const repliedSet = getRepliedMailKeys();

  // Render individual email items
  emails.forEach(email => {
    const item = document.createElement('div');
    const mailKey = getMailKey(email);
    const isRead = readSet.has(mailKey);
    const isReplied = repliedSet.has(mailKey);

    item.className = `mail-item ${isRead ? 'read' : 'unread'} ${isReplied ? 'replied' : ''}`;
    item.dataset.id = email.id;
    item.dataset.key = mailKey;
    if (selectedEmail && (selectedEmail.id === email.id || (selectedEmail.uniqueId && selectedEmail.uniqueId === email.uniqueId))) {
      item.classList.add('active');
    }

    const displaySender = email.from.split('<')[0].trim() || email.from;
    const displayDate = formatDate(email.date);

    item.innerHTML = `
      <div class="mail-item-header">
        <span class="mail-sender" title="${email.from}">${displaySender}</span>
        <div class="mail-header-right">
          <span class="mail-date">${displayDate}</span>
          <div class="mail-status-badges">
            ${isReplied ? `<span class="mail-status-badge mail-status-replied is-replied" title="회신 완료"><i data-lucide="corner-up-left"></i></span>` : ''}
            <span class="mail-status-badge mail-status-read ${isRead ? 'is-read' : 'is-unread'}" title="${isRead ? '읽음' : '읽지 않음'}">
              <i data-lucide="${isRead ? 'mail-open' : 'mail'}"></i>
            </span>
          </div>
        </div>
      </div>
      <div class="mail-subject" title="${email.subject}">${email.subject}</div>
    `;

    item.addEventListener('click', () => {
      markMailAsRead(email);
      selectEmail(email.id);
    });
    mailListContainer.appendChild(item);
  });
  lucide.createIcons();

  // If there are more emails to fetch within current cache, append "Load More" button
  if (emailsList.length < totalMailCount) {
    const btnContainer = document.createElement('div');
    btnContainer.className = 'load-more-container';
    btnContainer.innerHTML = `
      <button id="btn-load-more" class="btn-load-more">
        <i data-lucide="chevron-down"></i> 이전 메일 더 보기
      </button>
    `;
    mailListContainer.appendChild(btnContainer);
    lucide.createIcons();

    document.getElementById('btn-load-more').addEventListener('click', () => {
      if (!isLoadingMore) {
        currentPage++;
        fetchEmails(true);
      }
    });
  } else if (!searchQuery && totalMailCount < serverTotalCount) {
    // Reached current cache limit (e.g. 500), but server has more!
    const btnContainer = document.createElement('div');
    btnContainer.className = 'load-more-container';
    btnContainer.style.flexDirection = 'column';
    btnContainer.style.gap = '0.35rem';
    btnContainer.innerHTML = `
      <button id="btn-load-more-server" class="btn-load-more btn-load-more-server">
        <i data-lucide="cloud-download"></i> 서버에서 메일 500개 더 불러오기
      </button>
      <div class="server-mail-info" style="font-size: 0.72rem; color: var(--text-muted); text-align: center;">현재 ${totalMailCount}개 / 서버 총 ${serverTotalCount}개</div>
    `;
    mailListContainer.appendChild(btnContainer);
    lucide.createIcons();

    document.getElementById('btn-load-more-server').addEventListener('click', loadMoreFromServer);
  } else if (emailsList.length > 0) {
    const endContainer = document.createElement('div');
    endContainer.className = 'list-end-marker';
    endContainer.innerHTML = `<span>마지막 메일입니다.</span>`;
    mailListContainer.appendChild(endContainer);
  }
}

// Open New Mail Composer
function openNewMailCompose() {
  isComposingNewMail = true;
  selectedEmail = null;

  // Make sure we are in 'mail' mode
  if (currentMode !== 'mail') {
    switchWorkspaceMode('mail');
  }

  // Remove active class from mail list items
  document.querySelectorAll('.mail-item').forEach(item => {
    item.classList.remove('active');
  });

  // Toggle panels
  document.getElementById('welcome-panel').classList.add('hidden');
  document.getElementById('workspace-panel').classList.add('hidden');
  const messengerPanel = document.getElementById('messenger-panel');
  if (messengerPanel) messengerPanel.classList.add('hidden');
  document.getElementById('compose-panel').classList.remove('hidden');

  // Update prompt editor
  updateNewEmailPromptEditor();

  // Pre-populate compose CC with default taeyoung@ilogen.com if empty
  const composeCc = document.getElementById('compose-cc');
  if (composeCc && !composeCc.value.trim()) {
    composeCc.value = 'taeyoung@ilogen.com';
  }

  // Focus guide input
  setTimeout(() => {
    const focusTarget = document.getElementById('compose-recipient-info');
    if (focusTarget) focusTarget.focus();
  }, 50);

  lucide.createIcons();
}

// Apply recipients based on reply mode ('reply' or 'reply-all')
function applyReplyModeRecipients() {
  if (!selectedEmail) return;

  const btnModeReply = document.getElementById('btn-mode-reply');
  const btnModeReplyAll = document.getElementById('btn-mode-reply-all');
  if (btnModeReply && btnModeReplyAll) {
    if (currentReplyMode === 'reply-all') {
      btnModeReplyAll.classList.add('active');
      btnModeReply.classList.remove('active');
    } else {
      btnModeReply.classList.add('active');
      btnModeReplyAll.classList.remove('active');
    }
  }

  const senderEmail = extractEmailAddress(selectedEmail.from);
  document.getElementById('draft-to').value = senderEmail;

  const defaultMyEmail = 'taeyoung@ilogen.com';
  const ccList = [defaultMyEmail];

  if (currentReplyMode === 'reply-all') {
    // Collect all To and CC participants from original email, excluding myself and the sender (already in To)
    const allParticipants = [
      ...parseEmailList(selectedEmail.to),
      ...parseEmailList(selectedEmail.cc)
    ];

    allParticipants.forEach(p => {
      const email = p.email.toLowerCase();
      if (email !== senderEmail.toLowerCase() && email !== defaultMyEmail.toLowerCase()) {
        if (!ccList.some(item => item.toLowerCase() === email)) {
          ccList.push(p.email);
        }
      }
    });
  }

  document.getElementById('draft-cc').value = ccList.join(', ');
}

function setReplyMode(mode) {
  currentReplyMode = mode;
  applyReplyModeRecipients();
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// Select and Fetch Single Email Detail
async function selectEmail(id) {
  isComposingNewMail = false;

  // Immediately mark as read from existing in-memory emailsList
  const foundEmail = emailsList.find(e => e.id === id);
  if (foundEmail) {
    markMailAsRead(foundEmail);
  }

  // Update active class in sidebar
  document.querySelectorAll('.mail-item').forEach(item => {
    item.classList.remove('active');
    if (parseInt(item.dataset.id, 10) === id) {
      item.classList.add('active');
    }
  });

  const mailBodyText = document.getElementById('mail-body-text');
  const mailBodyHtml = document.getElementById('mail-body-html');
  
  mailBodyText.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>메일 본문을 가져오는 중...</p>
    </div>
  `;
  mailBodyHtml.classList.add('hidden');
  mailBodyText.classList.remove('hidden');

  // Toggle workspaces
  document.getElementById('welcome-panel').classList.add('hidden');
  document.getElementById('compose-panel').classList.add('hidden');
  document.getElementById('workspace-panel').classList.remove('hidden');
  
  // Disable draft box on new selection
  document.getElementById('draft-box').classList.add('disabled');
  document.getElementById('reply-guide').value = '';
  document.getElementById('draft-to').value = '';
  document.getElementById('draft-cc').value = 'taeyoung@ilogen.com';
  document.getElementById('draft-subject').value = '';
  document.getElementById('draft-body').value = '';
  clearReplyAttachments();

  // Reset Chat Panel
  chatHistory = [];
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    chatMessages.innerHTML = `
      <div class="chat-message system">
        <i data-lucide="sparkles" class="chat-avatar-icon"></i>
        <div class="message-bubble">
          안녕하세요! 선택된 메일에 대해 궁금한 점을 편하게 물어보세요. 요약, 의도 파악, 어려운 비즈니스 용어 풀이 등을 도와드릴 수 있습니다.
        </div>
      </div>
    `;
  }
  const chatInput = document.getElementById('chat-input');
  if (chatInput) chatInput.value = '';
  const tabReply = document.getElementById('tab-reply');
  if (tabReply) tabReply.click();

  try {
    const response = await fetch(`/api/emails/${id}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '메일 상세 정보를 가져올 수 없습니다.');
    }

    selectedEmail = data;
    markMailAsRead(data);
    
    // Apply recipients according to current reply mode (default: reply, with Cc: taeyoung@ilogen.com)
    applyReplyModeRecipients();

    // Set header info
    document.getElementById('detail-subject').textContent = data.subject || '(제목 없음)';
    document.getElementById('detail-from').textContent = data.from || '';
    document.getElementById('detail-to').textContent = data.to || '';

    // Render CC header if exists
    const ccRow = document.getElementById('detail-cc-row');
    const ccSpan = document.getElementById('detail-cc');
    if (ccRow && ccSpan) {
      if (data.cc && data.cc.trim()) {
        ccSpan.textContent = data.cc;
        ccRow.classList.remove('hidden');
      } else {
        ccSpan.textContent = '';
        ccRow.classList.add('hidden');
      }
    }

    // Render Attachments header if exists
    const attRow = document.getElementById('detail-attachments-row');
    const attList = document.getElementById('detail-attachments-list');
    if (attRow && attList) {
      attList.innerHTML = '';
      if (data.attachments && data.attachments.length > 0) {
        attRow.classList.remove('hidden');
        data.attachments.forEach(att => {
          const pill = document.createElement('a');
          pill.className = 'attachment-pill';
          pill.href = `/api/emails/${data.id}/attachments/${att.id}`;
          pill.setAttribute('download', att.filename);
          pill.title = `${att.filename} 다운로드 (${formatFileSize(att.size)})`;
          pill.innerHTML = `
            <i data-lucide="download"></i>
            <span>${att.filename}</span>
            <span class="att-size">(${formatFileSize(att.size)})</span>
          `;
          attList.appendChild(pill);
        });
        lucide.createIcons();
      } else {
        attRow.classList.add('hidden');
      }
    }

    document.getElementById('detail-date').textContent = formatDate(data.date, true);

    // Show body
    if (data.html && data.html.trim() !== '' && data.html !== data.text) {
      mailBodyText.classList.add('hidden');
      mailBodyHtml.classList.remove('hidden');
      // Render HTML safely inside iframe to isolate styling
      const iframeDoc = mailBodyHtml.contentDocument || mailBodyHtml.contentWindow.document;
      iframeDoc.open();
      iframeDoc.write(`
        <html>
          <head>
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 14px; 
                line-height: 1.6; 
                color: #333333; 
                margin: 8px;
              }
              a { color: #2563eb; }
            </style>
          </head>
          <body>${data.html}</body>
        </html>
      `);
      iframeDoc.close();
    } else {
      mailBodyHtml.classList.add('hidden');
      mailBodyText.classList.remove('hidden');
      mailBodyText.textContent = data.text || '(본문 내용이 없습니다)';
    }

    // Update Email Prompt Live Viewer
    updateEmailPromptEditor();

  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
    mailBodyText.innerHTML = `<p style="color: var(--accent-danger)">오류: ${error.message}</p>`;
  }
}

// Generate Reply Draft using Gemini
async function generateAIDraft() {
  const guideText = document.getElementById('reply-guide').value.trim();
  const generateBtn = document.getElementById('btn-generate');
  const chkCustom = document.getElementById('chk-use-custom-email');
  const customEditor = document.getElementById('email-prompt-editor');
  
  if (!selectedEmail) {
    showToast('답장을 작성할 메일을 먼저 선택해주세요.', 'error');
    return;
  }

  const isCustomActive = chkCustom && chkCustom.checked;

  if (!isCustomActive && !guideText) {
    showToast('AI에게 요청할 답변 가이드나 요점을 적어주세요.', 'error');
    return;
  }

  // Loading state
  const originalBtnHtml = generateBtn.innerHTML;
  generateBtn.disabled = true;
  generateBtn.innerHTML = `<div class="spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; margin-right:8px;"></div> AI 초안 작성 중...`;

  try {
    // Create a minimized version of the email containing only plain text to keep the payload size small
    const minimalEmail = {
      subject: selectedEmail.subject,
      from: selectedEmail.from,
      date: selectedEmail.date,
      text: selectedEmail.text || ''
    };

    const payload = {
      originalEmail: minimalEmail,
      replyGuide: guideText
    };

    if (isCustomActive && customEditor && customEditor.value.trim()) {
      payload.customPrompt = customEditor.value.trim();
    }

    const response = await fetch('/api/generate-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '답장 생성에 실패했습니다.');
    }

    // Set draft box inputs
    document.getElementById('draft-subject').value = data.subject || `Re: ${selectedEmail.subject}`;
    
    // Build draft body with quoted email history below
    let generatedBody = data.body || '';
    if (selectedEmail) {
      const quoteHeader = `\n\n----- Original Message -----\nFrom: ${selectedEmail.from || ''}\nTo: ${selectedEmail.to || ''}${selectedEmail.cc ? '\nCc: ' + selectedEmail.cc : ''}\nSent: ${formatDate(selectedEmail.date, true)}\nSubject: ${selectedEmail.subject || ''}\n\n`;
      const originalContent = (selectedEmail.text || '').trim();
      generatedBody += quoteHeader + originalContent;
    }
    document.getElementById('draft-body').value = generatedBody;

    // Enable draft panel
    document.getElementById('draft-box').classList.remove('disabled');
    if (isCustomActive) {
      showToast('튜닝한 프롬프트로 메일 초안을 다듬었습니다!', 'success');
    } else {
      showToast('AI가 성공적으로 메일 초안을 다듬었습니다!', 'success');
    }

  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerHTML = originalBtnHtml;
    lucide.createIcons();
  }
}

// Copy Reply text to Clipboard
function copyDraftToClipboard() {
  const draftBody = document.getElementById('draft-body').value;
  if (!draftBody) return;

  navigator.clipboard.writeText(draftBody)
    .then(() => {
      showToast('답장 본문이 클립보드에 복사되었습니다.', 'success');
    })
    .catch(err => {
      console.error(err);
      showToast('클립보드 복사에 실패했습니다.', 'error');
    });
}

// Extract email address from From header (e.g. "Name <email@domain.com>")
function extractEmailAddress(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<([^>]+)>/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return fromHeader.trim();
}

// Send Reply via SMTP
async function sendReplyEmail() {
  const toEmail = document.getElementById('draft-to').value.trim();
  const ccEmail = document.getElementById('draft-cc').value.trim();
  const subject = document.getElementById('draft-subject').value.trim();
  const body = document.getElementById('draft-body').value.trim();
  const sendBtn = document.getElementById('btn-send-mail');

  if (!toEmail) {
    showToast('받는 사람(To) 이메일 주소를 입력해주세요.', 'error');
    return;
  }
  if (!subject || !body) {
    showToast('제목과 본문이 비어있습니다.', 'error');
    return;
  }

  let confirmMsg = `${toEmail} 주소로 답장 메일을 바로 전송하시겠습니까?`;
  if (ccEmail) {
    confirmMsg += `\n(참조: ${ccEmail})`;
  }
  const confirmSend = confirm(confirmMsg);
  if (!confirmSend) return;

  // Loading state
  const originalBtnHtml = sendBtn.innerHTML;
  sendBtn.disabled = true;
  sendBtn.innerHTML = `<div class="spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; margin-right:8px;"></div> 메일 발송 중...`;

  try {
    const response = await fetch('/api/send-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: toEmail,
        cc: ccEmail,
        subject: subject,
        body: body,
        attachments: replyAttachments,
        inlineImages: replyInlineImages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '메일 발송에 실패했습니다.');
    }

    if (selectedEmail) {
      markMailAsReplied(selectedEmail);
    }

    showToast('답장 메일이 성공적으로 전송되었습니다!', 'success');

  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = originalBtnHtml;
    lucide.createIcons();
  }
}

// Date Formatter Helper
function formatDate(dateStr, includeTime = false) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  
  if (includeTime) {
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
  
  // If same year, return MM-DD. Otherwise, return YYYY-MM-DD
  const currentYear = new Date().getFullYear();
  if (yyyy === currentYear) {
    return `${mm}-${dd}`;
  }
  return `${yyyy}-${mm}-${dd}`;
}

// Send Message in Mail Q&A Chat
async function sendChatMessage() {
  const chatInput = document.getElementById('chat-input');
  const chatMessages = document.getElementById('chat-messages');
  const messageText = chatInput.value.trim();

  if (!selectedEmail) {
    showToast('질문할 메일을 먼저 선택해주세요.', 'error');
    return;
  }

  if (!messageText) return;

  // Clear input
  chatInput.value = '';

  // Append user message
  appendChatMessage('user', messageText);

  // Append loading typing indicator
  const loadingId = 'chat-loading-' + Date.now();
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'chat-message model';
  loadingDiv.id = loadingId;
  loadingDiv.innerHTML = `
    <i data-lucide="sparkles" class="chat-avatar-icon"></i>
    <div class="message-bubble">
      <div class="typing-indicator">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
  chatMessages.appendChild(loadingDiv);
  lucide.createIcons();
  setTimeout(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }, 60);

  try {
    const response = await fetch('/api/mail-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        originalEmail: {
          subject: selectedEmail.subject,
          from: selectedEmail.from,
          date: selectedEmail.date,
          text: selectedEmail.text || '',
          html: selectedEmail.html || ''
        },
        message: messageText,
        history: chatHistory
      })
    });

    const data = await response.json();

    // Remove loading indicator
    const loadingElem = document.getElementById(loadingId);
    if (loadingElem) loadingElem.remove();

    if (!response.ok) {
      throw new Error(data.error || '답변 생성 중 에러가 발생했습니다.');
    }

    // Append AI reply
    appendChatMessage('model', data.reply);

    // Update history for subsequent messages
    chatHistory.push({
      role: 'user',
      parts: [{ text: messageText }]
    });
    chatHistory.push({
      role: 'model',
      parts: [{ text: data.reply }]
    });

  } catch (error) {
    console.error(error);
    const loadingElem = document.getElementById(loadingId);
    if (loadingElem) loadingElem.remove();
    showToast(error.message, 'error');
    appendChatMessage('system', `에러가 발생했습니다: ${error.message}`);
  }
}

// Append bubble to chat messages list
function appendChatMessage(role, text) {
  const chatMessages = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${role}`;

  let iconName = 'sparkles';
  if (role === 'user') iconName = 'user';

  if (role === 'system') {
    messageDiv.innerHTML = `
      <div class="message-bubble">${text}</div>
    `;
  } else {
    messageDiv.innerHTML = `
      <i data-lucide="${iconName}" class="chat-avatar-icon"></i>
      <div class="message-bubble">${formatChatText(text)}</div>
    `;
  }

  chatMessages.appendChild(messageDiv);
  lucide.createIcons();

  // Defer scrolling slightly to ensure DOM has repainted and scrollHeight is computed correctly
  setTimeout(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }, 60);
}

// Helper to format AI chat text (line breaks, bold, HTML escape)
function formatChatText(text) {
  if (!text) return '';
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/\n/g, '<br>');
  return formatted;
}

// Switch workspace between Email and Messenger mode
let currentMode = 'mail'; // 'mail' or 'messenger'
function switchWorkspaceMode(mode) {
  if (currentMode === mode) return;
  currentMode = mode;

  const modeMailBtn = document.getElementById('mode-mail');
  const modeMessengerBtn = document.getElementById('mode-messenger');
  const mailComposeBtnContainer = document.getElementById('mail-compose-btn-container');
  const mailSearchContainer = document.getElementById('mail-search-container');
  const mailSyncBarContainer = document.getElementById('mail-sync-bar-container');
  const mailSidebarContent = document.getElementById('mail-sidebar-content');
  const messengerSidebarContent = document.getElementById('messenger-sidebar-content');
  const messengerPanel = document.getElementById('messenger-panel');
  const welcomePanel = document.getElementById('welcome-panel');
  const workspacePanel = document.getElementById('workspace-panel');
  const composePanel = document.getElementById('compose-panel');
  const btnRefresh = document.getElementById('btn-refresh');

  if (mode === 'mail') {
    modeMailBtn.classList.add('active');
    modeMessengerBtn.classList.remove('active');
    if (mailComposeBtnContainer) mailComposeBtnContainer.classList.remove('hidden');
    if (mailSearchContainer) mailSearchContainer.classList.remove('hidden');
    if (mailSyncBarContainer) mailSyncBarContainer.classList.remove('hidden');
    mailSidebarContent.classList.remove('hidden');
    messengerSidebarContent.classList.add('hidden');
    messengerPanel.classList.add('hidden');
    if (btnRefresh) btnRefresh.classList.remove('hidden');

    // Restore mail view depending on current state
    if (isComposingNewMail) {
      if (composePanel) composePanel.classList.remove('hidden');
      workspacePanel.classList.add('hidden');
      welcomePanel.classList.add('hidden');
    } else if (selectedEmail) {
      workspacePanel.classList.remove('hidden');
      if (composePanel) composePanel.classList.add('hidden');
      welcomePanel.classList.add('hidden');
    } else {
      welcomePanel.classList.remove('hidden');
      workspacePanel.classList.add('hidden');
      if (composePanel) composePanel.classList.add('hidden');
    }
  } else {
    modeMessengerBtn.classList.add('active');
    modeMailBtn.classList.remove('active');
    if (mailComposeBtnContainer) mailComposeBtnContainer.classList.add('hidden');
    if (mailSearchContainer) mailSearchContainer.classList.add('hidden');
    if (mailSyncBarContainer) mailSyncBarContainer.classList.add('hidden');
    mailSidebarContent.classList.add('hidden');
    messengerSidebarContent.classList.remove('hidden');
    messengerPanel.classList.remove('hidden');
    welcomePanel.classList.add('hidden');
    workspacePanel.classList.add('hidden');
    if (composePanel) composePanel.classList.add('hidden');
    if (btnRefresh) btnRefresh.classList.add('hidden');
  }
  lucide.createIcons();
}

// Generate Messenger Advice & Recommended Replies
async function generateMessengerAdvice() {
  const chatHistoryText = document.getElementById('messenger-chat-history').value.trim();
  const keywordsText = document.getElementById('messenger-keywords').value.trim();
  const generateBtn = document.getElementById('btn-generate-messenger');
  const adviceContent = document.getElementById('messenger-advice-content');
  const repliesList = document.getElementById('messenger-replies-list');
  const chkCustom = document.getElementById('chk-use-custom-messenger');
  const customEditor = document.getElementById('messenger-prompt-editor');

  const isCustomActive = chkCustom && chkCustom.checked;

  if (!isCustomActive && !chatHistoryText && !keywordsText) {
    showToast('대화 내역이나 답변 키워드 중 최소 하나는 입력해주세요.', 'error');
    return;
  }

  // Loading UI state
  const originalBtnHtml = generateBtn.innerHTML;
  generateBtn.disabled = true;
  generateBtn.innerHTML = `<div class="spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; margin-right:8px;"></div> AI 답변 분석 중...`;
  
  adviceContent.innerHTML = `
    <div class="loading-state" style="padding: 1.5rem 0;">
      <div class="spinner"></div>
      <p>대화의 맥락을 분석하고 조언을 생성하는 중...</p>
    </div>
  `;

  repliesList.innerHTML = `
    <div class="loading-state" style="padding: 1.5rem 0;">
      <div class="spinner"></div>
      <p>맞춤형 답변 초안들을 작성하고 있습니다...</p>
    </div>
  `;

  try {
    const payload = {
      chatHistory: chatHistoryText,
      keywords: keywordsText
    };

    if (isCustomActive && customEditor && customEditor.value.trim()) {
      payload.customPrompt = customEditor.value.trim();
    }

    const response = await fetch('/api/generate-messenger-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '답변 생성에 실패했습니다.');
    }

    // Render Advice
    adviceContent.innerHTML = formatChatText(data.analysis || '조언이 없습니다.');

    // Render Replies
    repliesList.innerHTML = '';
    const replies = data.replies || [];

    if (replies.length === 0) {
      repliesList.innerHTML = `<div class="empty-state-text">추천 답변 초안이 없습니다.</div>`;
    } else {
      replies.forEach((reply, idx) => {
        const replyItem = document.createElement('div');
        replyItem.className = 'messenger-reply-item';
        
        replyItem.innerHTML = `
          <div class="reply-item-header">
            <span class="reply-item-label">${reply.label || `옵션 ${idx + 1}`}</span>
            <button class="btn-copy-reply" data-text="${reply.text.replace(/"/g, '&quot;')}">
              <i data-lucide="copy"></i> 복사
            </button>
          </div>
          <div class="reply-item-content">${formatChatText(reply.text)}</div>
        `;
        
        // Add Copy listener
        const copyBtn = replyItem.querySelector('.btn-copy-reply');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(reply.text)
            .then(() => {
              showToast(`'${reply.label}' 텍스트가 복사되었습니다!`, 'success');
            })
            .catch(err => {
              console.error(err);
              showToast('복사에 실패했습니다.', 'error');
            });
        });

        repliesList.appendChild(replyItem);
      });
    }

    if (isCustomActive) {
      showToast('튜닝한 프롬프트로 메신저 조언 및 답장을 생성했습니다!', 'success');
    }

  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
    adviceContent.innerHTML = `<p style="color: var(--accent-danger)">오류: ${error.message}</p>`;
    repliesList.innerHTML = `<p style="color: var(--accent-danger); text-align: center; padding: 2rem;">답변을 불러오지 못했습니다.</p>`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerHTML = originalBtnHtml;
    lucide.createIcons();
  }
}

// Generate New Mail Draft using Gemini AI
async function generateNewMailAIDraft() {
  const recipientInfo = document.getElementById('compose-recipient-info').value.trim();
  const subjectHint = document.getElementById('compose-subject-hint').value.trim();
  const contentGuide = document.getElementById('compose-content-guide').value.trim();
  const generateBtn = document.getElementById('btn-generate-newmail');
  const chkCustom = document.getElementById('chk-use-custom-newmail');
  const customEditor = document.getElementById('newmail-prompt-editor');

  const isCustomActive = chkCustom && chkCustom.checked;

  if (!isCustomActive && !contentGuide && !subjectHint) {
    showToast('메일 작성 요점이나 제목 키워드를 입력해주세요.', 'error');
    return;
  }

  const originalBtnHtml = generateBtn.innerHTML;
  generateBtn.disabled = true;
  generateBtn.innerHTML = `<div class="spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; margin-right:8px;"></div> AI 새 메일 작성 중...`;

  try {
    const payload = {
      recipientInfo,
      subjectHint,
      mailContentGuide: contentGuide
    };

    if (isCustomActive && customEditor && customEditor.value.trim()) {
      payload.customPrompt = customEditor.value.trim();
    }

    const response = await fetch('/api/generate-new-mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '새 메일 생성에 실패했습니다.');
    }

    document.getElementById('compose-subject').value = data.subject || subjectHint || '업무 관련 문의의 건';
    document.getElementById('compose-body').value = data.body || '';

    if (isCustomActive) {
      showToast('튜닝한 프롬프트로 새 메일 초안을 생성했습니다!', 'success');
    } else {
      showToast('AI가 정중한 비즈니스 새 메일 초안을 완성했습니다!', 'success');
    }
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerHTML = originalBtnHtml;
    lucide.createIcons();
  }
}

// Copy New Mail Draft to Clipboard
function copyNewMailDraftToClipboard() {
  const draftBody = document.getElementById('compose-body').value;
  if (!draftBody) {
    showToast('복사할 본문 내용이 없습니다.', 'error');
    return;
  }

  navigator.clipboard.writeText(draftBody)
    .then(() => {
      showToast('새 메일 본문이 클립보드에 복사되었습니다.', 'success');
    })
    .catch(err => {
      console.error(err);
      showToast('클립보드 복사에 실패했습니다.', 'error');
    });
}

// Send New Mail via SMTP
async function sendNewMailEmail() {
  const toEmail = document.getElementById('compose-to').value.trim();
  const ccEmail = document.getElementById('compose-cc').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value.trim();
  const sendBtn = document.getElementById('btn-send-newmail');

  if (!toEmail) {
    showToast('받는 사람(To) 이메일 주소를 입력해주세요.', 'error');
    document.getElementById('compose-to').focus();
    return;
  }
  if (!subject || !body) {
    showToast('제목과 본문을 입력해주세요.', 'error');
    return;
  }

  let confirmMsg = `${toEmail} 주소로 새 메일을 바로 전송하시겠습니까?`;
  if (ccEmail) {
    confirmMsg += `\n(참조: ${ccEmail})`;
  }
  const confirmSend = confirm(confirmMsg);
  if (!confirmSend) return;

  const originalBtnHtml = sendBtn.innerHTML;
  sendBtn.disabled = true;
  sendBtn.innerHTML = `<div class="spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; margin-right:8px;"></div> 메일 발송 중...`;

  try {
    const response = await fetch('/api/send-mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: toEmail,
        cc: ccEmail,
        subject: subject,
        body: body,
        attachments: composeAttachments,
        inlineImages: composeInlineImages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '메일 발송에 실패했습니다.');
    }

    showToast('새 메일이 성공적으로 전송되었습니다!', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = originalBtnHtml;
    lucide.createIcons();
  }
}

// Prompt Tuning UI & Generator Helpers
async function loadDefaultPrompts() {
  try {
    const res = await fetch('/api/default-prompts');
    if (res.ok) {
      const data = await res.json();
      defaultEmailPromptTemplate = data.emailPromptTemplate || '';
      defaultNewEmailPromptTemplate = data.newEmailPromptTemplate || '';
      defaultMessengerPromptTemplate = data.messengerPromptTemplate || '';
    }
  } catch (err) {
    console.error('Failed to fetch default prompt templates:', err);
  }
  updateEmailPromptEditor();
  updateNewEmailPromptEditor();
  updateMessengerPromptEditor();
}

function buildCurrentEmailPrompt() {
  const replyGuide = document.getElementById('reply-guide')?.value.trim() || '';
  const from = selectedEmail?.from || '(선택된 메일 없음)';
  const subject = selectedEmail?.subject || '(선택된 메일 없음)';
  const date = selectedEmail?.date || '(선택된 메일 없음)';
  const text = selectedEmail?.text || selectedEmail?.html || '(메일 본문 내용 없음)';

  if (defaultEmailPromptTemplate) {
    return defaultEmailPromptTemplate
      .replace('{{from}}', from)
      .replace('{{subject}}', subject)
      .replace('{{date}}', date)
      .replace('{{text}}', text)
      .replace('{{replyGuide}}', replyGuide || '(작성할 요점 없음 - 메일 맥락에 맞춰 작성)');
  }

  return `You are a professional business email assistant and editor.
Your task is to refine and format the user's keywords/draft into a polite, professional Korean business email.

CRITICAL INSTRUCTIONS (엄격한 작성 지침):
1. ONLY REFINE USER'S KEYWORDS (사용자 키워드 기반 문장 다듬기):
   - Include ONLY the contents, facts, and intent explicitly specified in [User's Reply Instruction/Keywords].
   - Your primary role is strictly an EDITOR: transform rough keywords and bullet points into clear, polite, and refined Korean business sentences.
   - DO NOT invent, assume, or add new facts, promises, schedule items, or arbitrary details on your own. Do not over-generate content beyond what the user provided.
   - Fix grammatical errors and polish into standard Korean business etiquette (정중하고 매끄러운 톤앤매너).

2. ORIGINAL EMAIL IS FOR REFERENCE ONLY (원본 메일은 단순 참고용):
   - [Original Email] is provided strictly for contextual background (to understand business terminology, project context, or reference points).
   - Do NOT arbitrarily bring extraneous topics or unmentioned facts from the original email into the draft unless directly requested in the user's keywords.

3. RECIPIENT & PURPOSE FLEXIBILITY (수신자 및 전달 대상 유연성):
   - Note: This email might NOT be sent directly to the original sender. It may be forwarded, shared, or reported to another team member, supervisor, or external partner based on the context.
   - Do not assume a specific recipient unless indicated in [User's Reply Instruction/Keywords]. Keep the tone versatile and professional.

[Original Email Header]
From: ${from}
Subject: ${subject}
Date: ${date}

[Original Email Body]
${text}

[User's Reply Instruction/Keywords]
${replyGuide || '(작성할 요점 없음 - 메일 맥락에 맞춰 작성)'}

Instructions:
1. Write the response in natural, polite Korean business style (한국어 비즈니스 이메일 톤앤매너).
2. Faithfully express ONLY the core content and intent from the user's keywords without adding unauthorized details or dropping user points.
3. Fix all grammatical issues and refine rough expressions into professional business language.
4. The body of the generated response MUST strictly adhere to the following signature template format (do not omit greetings and signature):
안녕하세요.
로젠 정보전략팀 김태영입니다.

[Refined message body goes here]

감사합니다.

로젠택배 정보전략팀 김태영 책임

5. Output an appropriate email subject (e.g. prefixed with "Re: " if replying, or a concise title if forwarding/sharing) and the structured reply body.
6. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.`;
}

function buildCurrentNewEmailPrompt() {
  const recipientInfo = document.getElementById('compose-recipient-info')?.value.trim() || '';
  const subjectHint = document.getElementById('compose-subject-hint')?.value.trim() || '';
  const mailContentGuide = document.getElementById('compose-content-guide')?.value.trim() || '';

  if (defaultNewEmailPromptTemplate) {
    return defaultNewEmailPromptTemplate
      .replace('{{recipientInfo}}', recipientInfo || '(수신자 특별 지정 없음 - 정중하고 일반적인 비즈니스 수신자 호칭 적용)')
      .replace('{{subjectHint}}', subjectHint || '(작성된 본문 핵심 내용을 바탕으로 명확한 비즈니스 제목 생성)')
      .replace('{{mailContentGuide}}', mailContentGuide || '(상대방에게 정중하게 인사를 전하고 업무 협의를 제안하는 내용)');
  }

  return `You are a professional business email assistant.
Your task is to compose a polite, professional, and well-structured Korean business email from scratch (신규 메일 최초 발송) based on the user's requirements.

CRITICAL INSTRUCTION:
- PRESERVE ALL DETAILS, FACTS, DATES, NUMBERS, AND REQUESTS from the user's guide without omitting or distorting anything.
- Act as a professional business writer & formatter: refine rough phrasing, structure the email clearly, and adhere to standard Korean business email etiquette.

[Recipient Info / Context]
${recipientInfo || '(수신자 특별 지정 없음 - 정중하고 일반적인 비즈니스 수신자 호칭 적용)'}

[Subject Keyword / Topic]
${subjectHint || '(작성된 본문 핵심 내용을 바탕으로 명확한 비즈니스 제목 생성)'}

[User's Message & Core Points]
${mailContentGuide || '(상대방에게 정중하게 인사를 전하고 업무 협의를 제안하는 내용)'}

Instructions:
1. Write in polite, respectful, and natural Korean business email tone (한국어 비즈니스 이메일 톤앤매너).
2. Propose a clear, professional, and concise subject line appropriate for the email topic (do NOT include "Re:").
3. The body MUST strictly adhere to the following structure and signature format:
안녕하세요. ${recipientInfo ? recipientInfo.trim() + '님' : ''}
로젠 정보전략팀 김태영입니다.

[Refined and well-structured message body: clear context, core message, dates, action requests]

감사합니다.

로젠택배 정보전략팀 김태영 책임

4. Fix all grammatical errors and polish into executive-level professional wording.
5. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.`;
}

function buildCurrentMessengerPrompt() {
  const chatHistoryText = document.getElementById('messenger-chat-history')?.value.trim() || '';
  const keywordsText = document.getElementById('messenger-keywords')?.value.trim() || '';

  if (defaultMessengerPromptTemplate) {
    return defaultMessengerPromptTemplate
      .replace('{{chatHistory}}', chatHistoryText || '(이전 대화 내역 없음 - 상대방에게 처음 대화를 선제적으로 건네는 상황입니다.)')
      .replace('{{keywords}}', keywordsText || '(특별히 지정된 키워드 없음. 대화 맥락에 따라 가장 자연스러운 답변 작성)');
  }

  return `당신은 사내 메신저 대화 분석 및 답변 작성을 돕는 비즈니스 커뮤니케이션 코치입니다.
사용자가 대화 내역(chatHistory)과 답변하고 싶은 키워드/의도(keywords)를 제공하면, 다음 보낼 메신저 답장을 작성하고 이에 대한 조언을 제공해야 합니다.

핵심 지침 (내용 유지 & 규격 다듬기):
- 사용자가 입력한 [답변 키워드 및 의도]의 핵심 내용, 조건, 일정, 전달 사항을 절대로 누락하거나 임의로 바꾸지 말고 최대한 원본 그대로 유지하세요.
- 당신의 주요 역할은 사용자가 작성한 입력 내용을 사내 메신저 규격과 정중한 어조에 맞게 매끄럽게 다듬고 문법/오탈자를 교정해 주는 것입니다.

[사용자가 제공한 대화 내역]
${chatHistoryText || '(이전 대화 내역 없음 - 상대방에게 처음 대화를 선제적으로 건네는 상황입니다.)'}

[사용자가 원하는 답변 키워드 및 의도]
${keywordsText || '(특별히 지정된 키워드 없음. 대화 맥락에 따라 가장 자연스러운 답변 작성)'}

지침:
1. 사용자가 입력한 [답변 키워드 및 의도]의 정보와 메시지를 임의 축소/변경 없이 100% 반영하여 다듬으세요.
2. 대화 내역(chatHistory)이 주어졌다면 맥락을 분석하여 상대방의 소속/이름/직급에 맞는 적절한 호칭과 어조로 다듬으세요.
3. 대화 내역(chatHistory)이 비어있다면, 선제적으로 상대방에게 대화를 시작(첫 인사 및 용건 제시)하는 상황입니다. 입력된 키워드 용건을 바탕으로 정중하게 말을 거는 메시지로 다듬으세요.
4. 메신저는 이메일보다 비교적 즉각적이고 짧은 호흡으로 진행되므로, 서명 등 불필요한 이메일 양식 없이 자연스럽고 깔끔한 메신저 어조로 완성하세요.
5. 조언(analysis) 영역에서는 상황을 요약 분석하고 대화 시 주의해야 할 비즈니스 매너 또는 팁을 설명해 주세요. (한국어로 작성)
6. 답변 초안(replies)은 총 3가지 스타일로 제안해 주세요:
   - "격식있고 정중한 답변" (상급자나 격식이 필요한 상대)
   - "부드럽고 친근한 답변" (동료나 친밀한 협업 담당자)
   - "간결하고 신속한 답변" (빠른 피드백이 필요한 상황)
7. 반드시 JSON 형식으로만 응답해야 하며, 그 외의 텍스트나 마크다운 코드 블록(\`\`\`json)은 포함하지 마십시오.

반환할 JSON 구조:
{
  "analysis": "여기에 현재 상황 분석 및 메신저 대화 팁을 작성하세요 (줄바꿈은 \\n 사용)",
  "replies": [
    {
      "label": "격식있고 정중한 답변",
      "text": "실제 전송할 메신저 메시지 텍스트"
    },
    {
      "label": "부드럽고 친근한 답변",
      "text": "실제 전송할 메신저 메시지 텍스트"
    },
    {
      "label": "간결하고 신속한 답변",
      "text": "실제 전송할 메신저 메시지 텍스트"
    }
  ]
}`;
}

function updateEmailPromptEditor() {
  const chkUseCustom = document.getElementById('chk-use-custom-email');
  if (!chkUseCustom || !chkUseCustom.checked) {
    const editor = document.getElementById('email-prompt-editor');
    if (editor) {
      editor.value = buildCurrentEmailPrompt();
    }
  }
}

function updateNewEmailPromptEditor() {
  const chkUseCustom = document.getElementById('chk-use-custom-newmail');
  if (!chkUseCustom || !chkUseCustom.checked) {
    const editor = document.getElementById('newmail-prompt-editor');
    if (editor) {
      editor.value = buildCurrentNewEmailPrompt();
    }
  }
}

function updateMessengerPromptEditor() {
  const chkUseCustom = document.getElementById('chk-use-custom-messenger');
  if (!chkUseCustom || !chkUseCustom.checked) {
    const editor = document.getElementById('messenger-prompt-editor');
    if (editor) {
      editor.value = buildCurrentMessengerPrompt();
    }
  }
}

function initPromptTuningUI() {
  // Email Accordion
  const btnToggleEmail = document.getElementById('btn-toggle-prompt-email');
  const panelEmail = document.getElementById('panel-prompt-email');
  const chkEmail = document.getElementById('chk-use-custom-email');
  const badgeEmail = document.getElementById('badge-custom-email');
  const editorEmail = document.getElementById('email-prompt-editor');
  const btnResetEmail = document.getElementById('btn-reset-prompt-email');

  if (btnToggleEmail && panelEmail) {
    btnToggleEmail.addEventListener('click', () => {
      panelEmail.classList.toggle('hidden');
      btnToggleEmail.classList.toggle('active');
    });
  }

  if (editorEmail && chkEmail) {
    editorEmail.addEventListener('input', () => {
      chkEmail.checked = true;
      if (badgeEmail) badgeEmail.classList.remove('hidden');
    });
  }

  if (chkEmail) {
    chkEmail.addEventListener('change', () => {
      if (chkEmail.checked) {
        if (badgeEmail) badgeEmail.classList.remove('hidden');
      } else {
        if (badgeEmail) badgeEmail.classList.add('hidden');
        updateEmailPromptEditor();
      }
    });
  }

  if (btnResetEmail) {
    btnResetEmail.addEventListener('click', () => {
      if (chkEmail) chkEmail.checked = false;
      if (badgeEmail) badgeEmail.classList.add('hidden');
      updateEmailPromptEditor();
      showToast('기본 프롬프트 템플릿으로 복원되었습니다.', 'info');
    });
  }

  // New Mail Accordion
  const btnToggleNewMail = document.getElementById('btn-toggle-prompt-newmail');
  const panelNewMail = document.getElementById('panel-prompt-newmail');
  const chkNewMail = document.getElementById('chk-use-custom-newmail');
  const badgeNewMail = document.getElementById('badge-custom-newmail');
  const editorNewMail = document.getElementById('newmail-prompt-editor');
  const btnResetNewMail = document.getElementById('btn-reset-prompt-newmail');

  if (btnToggleNewMail && panelNewMail) {
    btnToggleNewMail.addEventListener('click', () => {
      panelNewMail.classList.toggle('hidden');
      btnToggleNewMail.classList.toggle('active');
    });
  }

  if (editorNewMail && chkNewMail) {
    editorNewMail.addEventListener('input', () => {
      chkNewMail.checked = true;
      if (badgeNewMail) badgeNewMail.classList.remove('hidden');
    });
  }

  if (chkNewMail) {
    chkNewMail.addEventListener('change', () => {
      if (chkNewMail.checked) {
        if (badgeNewMail) badgeNewMail.classList.remove('hidden');
      } else {
        if (badgeNewMail) badgeNewMail.classList.add('hidden');
        updateNewEmailPromptEditor();
      }
    });
  }

  if (btnResetNewMail) {
    btnResetNewMail.addEventListener('click', () => {
      if (chkNewMail) chkNewMail.checked = false;
      if (badgeNewMail) badgeNewMail.classList.add('hidden');
      updateNewEmailPromptEditor();
      showToast('기본 새 메일 프롬프트 템플릿으로 복원되었습니다.', 'info');
    });
  }

  // Messenger Accordion
  const btnToggleMessenger = document.getElementById('btn-toggle-prompt-messenger');
  const panelMessenger = document.getElementById('panel-prompt-messenger');
  const chkMessenger = document.getElementById('chk-use-custom-messenger');
  const badgeMessenger = document.getElementById('badge-custom-messenger');
  const editorMessenger = document.getElementById('messenger-prompt-editor');
  const btnResetMessenger = document.getElementById('btn-reset-prompt-messenger');

  if (btnToggleMessenger && panelMessenger) {
    btnToggleMessenger.addEventListener('click', () => {
      panelMessenger.classList.toggle('hidden');
      btnToggleMessenger.classList.toggle('active');
    });
  }

  if (editorMessenger && chkMessenger) {
    editorMessenger.addEventListener('input', () => {
      chkMessenger.checked = true;
      if (badgeMessenger) badgeMessenger.classList.remove('hidden');
    });
  }

  if (chkMessenger) {
    chkMessenger.addEventListener('change', () => {
      if (chkMessenger.checked) {
        if (badgeMessenger) badgeMessenger.classList.remove('hidden');
      } else {
        if (badgeMessenger) badgeMessenger.classList.add('hidden');
        updateMessengerPromptEditor();
      }
    });
  }

  if (btnResetMessenger) {
    btnResetMessenger.addEventListener('click', () => {
      if (chkMessenger) chkMessenger.checked = false;
      if (badgeMessenger) badgeMessenger.classList.add('hidden');
      updateMessengerPromptEditor();
      showToast('기본 프롬프트 템플릿으로 복원되었습니다.', 'info');
    });
  }
}

// -----------------------------------------------------------------------------
// Attachment & Clipboard Image Pasting Handlers
// -----------------------------------------------------------------------------
function initAttachmentAndPasteHandlers() {
  // 1. Reply Draft Attachments & Paste
  const draftBody = document.getElementById('draft-body');
  const replyFileInput = document.getElementById('reply-file-input');
  const btnReplyAttach = document.getElementById('btn-reply-attach-file');

  if (btnReplyAttach && replyFileInput) {
    btnReplyAttach.addEventListener('click', () => replyFileInput.click());
    replyFileInput.addEventListener('change', (e) => {
      handleFileSelection(e.target.files, 'reply');
      replyFileInput.value = ''; // Reset input to allow re-selecting same file
    });
  }

  if (draftBody) {
    draftBody.addEventListener('paste', (e) => {
      handleClipboardPaste(e, draftBody, 'reply');
    });
  }

  // 2. Compose (New Mail) Attachments & Paste
  const composeBody = document.getElementById('compose-body');
  const composeFileInput = document.getElementById('compose-file-input');
  const btnComposeAttach = document.getElementById('btn-compose-attach-file');

  if (btnComposeAttach && composeFileInput) {
    btnComposeAttach.addEventListener('click', () => composeFileInput.click());
    composeFileInput.addEventListener('change', (e) => {
      handleFileSelection(e.target.files, 'compose');
      composeFileInput.value = '';
    });
  }

  if (composeBody) {
    composeBody.addEventListener('paste', (e) => {
      handleClipboardPaste(e, composeBody, 'compose');
    });
  }
}

// Handle Clipboard Paste for Images
function handleClipboardPaste(e, textareaEl, context = 'reply') {
  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData || !clipboardData.items) return;

  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item.type.indexOf('image') !== -1) {
      const file = item.getAsFile();
      if (!file) continue;

      e.preventDefault(); // Prevent pasting raw junk into textarea

      const reader = new FileReader();
      reader.onload = function(event) {
        const base64Data = event.target.result;
        const imgId = 'img_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const imageToken = `\n[이미지: ${imgId}]\n`;

        const imageObj = {
          cid: imgId,
          filename: `pasted_image_${Date.now()}.png`,
          data: base64Data,
          size: file.size,
          contentType: file.type || 'image/png'
        };

        if (context === 'reply') {
          replyInlineImages.push(imageObj);
          renderAttachmentChips('reply');
        } else {
          composeInlineImages.push(imageObj);
          renderAttachmentChips('compose');
        }

        // Insert placeholder token at current cursor position in textarea
        insertTextAtCursor(textareaEl, imageToken);
        showToast('클립보드 이미지가 본문에 삽입되었습니다!', 'success');
      };
      reader.readAsDataURL(file);
      break; // Process one image per paste event
    }
  }
}

// Helper: Insert text at current cursor position of textarea
function insertTextAtCursor(textarea, text) {
  const startPos = textarea.selectionStart;
  const endPos = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.substring(0, startPos) + text + val.substring(endPos, val.length);
  textarea.selectionStart = textarea.selectionEnd = startPos + text.length;
  textarea.focus();
}

// Handle File Selection (docx, xlsx, pdf, zip, etc.)
function handleFileSelection(files, context = 'reply') {
  if (!files || files.length === 0) return;

  const maxFileSize = 25 * 1024 * 1024; // 25MB per file
  Array.from(files).forEach(file => {
    if (file.size > maxFileSize) {
      showToast(`'${file.name}' 파일이 너무 큽니다. (최대 25MB)`, 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
      const base64Data = event.target.result;
      const fileObj = {
        filename: file.name,
        data: base64Data,
        size: file.size,
        contentType: file.type || 'application/octet-stream'
      };

      if (context === 'reply') {
        replyAttachments.push(fileObj);
        renderAttachmentChips('reply');
      } else {
        composeAttachments.push(fileObj);
        renderAttachmentChips('compose');
      }

      showToast(`'${file.name}' 첨부 완료`, 'info');
    };
    reader.readAsDataURL(file);
  });
}

// Render attachment chips
function renderAttachmentChips(context = 'reply') {
  const containerId = context === 'reply' ? 'reply-attachment-list' : 'compose-attachment-list';
  const container = document.getElementById(containerId);
  if (!container) return;

  const attachments = context === 'reply' ? replyAttachments : composeAttachments;
  const inlineImages = context === 'reply' ? replyInlineImages : composeInlineImages;

  const totalCount = attachments.length + inlineImages.length;
  if (totalCount === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = '';

  // 1. Render inline images
  inlineImages.forEach((img, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip is-image';
    chip.title = `본문에 [이미지: ${img.cid}] 태그로 표시됩니다.`;

    chip.innerHTML = `
      <img src="${img.data}" class="attachment-chip-thumb" alt="미리보기" />
      <span class="attachment-chip-name">이미지 (${img.cid})</span>
      <span class="attachment-chip-size">${formatFileSize(img.size)}</span>
      <button type="button" class="attachment-chip-remove" title="이미지 삭제">
        <i data-lucide="x"></i>
      </button>
    `;

    const removeBtn = chip.querySelector('.attachment-chip-remove');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Remove token from textarea
      const textarea = document.getElementById(context === 'reply' ? 'draft-body' : 'compose-body');
      if (textarea) {
        const token = `[이미지: ${img.cid}]`;
        textarea.value = textarea.value.replace(token, '').trim();
      }
      inlineImages.splice(idx, 1);
      renderAttachmentChips(context);
    });

    container.appendChild(chip);
  });

  // 2. Render files (docx, xlsx, etc.)
  attachments.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.title = `${file.filename} (${formatFileSize(file.size)})`;

    let iconName = 'file-text';
    const ext = file.filename.split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      iconName = 'sheet';
    } else if (['docx', 'doc'].includes(ext)) {
      iconName = 'file-text';
    } else if (ext === 'pdf') {
      iconName = 'file';
    } else if (['zip', 'rar', '7z'].includes(ext)) {
      iconName = 'archive';
    }

    chip.innerHTML = `
      <span class="attachment-chip-icon"><i data-lucide="${iconName}"></i></span>
      <span class="attachment-chip-name">${file.filename}</span>
      <span class="attachment-chip-size">${formatFileSize(file.size)}</span>
      <button type="button" class="attachment-chip-remove" title="첨부 삭제">
        <i data-lucide="x"></i>
      </button>
    `;

    const removeBtn = chip.querySelector('.attachment-chip-remove');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachments.splice(idx, 1);
      renderAttachmentChips(context);
    });

    container.appendChild(chip);
  });

  lucide.createIcons();
}

function clearReplyAttachments() {
  replyAttachments = [];
  replyInlineImages = [];
  renderAttachmentChips('reply');
}

function clearComposeAttachments() {
  composeAttachments = [];
  composeInlineImages = [];
  renderAttachmentChips('compose');
}

