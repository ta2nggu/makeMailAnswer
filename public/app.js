// State Management
let selectedEmail = null;
let emailsList = [];
let currentPage = 1;
let totalMailCount = 0;
const limitPerPage = 10;
let isLoadingMore = false;
let searchQuery = '';
let searchDebounceTimeout = null;
let chatHistory = [];

function debounceSearch(callback, delay = 400) {
  return function(...args) {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => callback.apply(this, args), delay);
  };
}

// Initialize Icons
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  fetchEmails(false); // Auto fetch page 1 on load
  initSplitPane(); // Activate resizable splitter
  
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
  document.getElementById('btn-welcome-refresh').addEventListener('click', () => fetchEmails(false));
  document.getElementById('btn-generate').addEventListener('click', generateAIDraft);
  document.getElementById('btn-copy').addEventListener('click', copyDraftToClipboard);
  document.getElementById('btn-send-mail').addEventListener('click', sendReplyEmail);

  // Bind Search Events
  const searchInput = document.getElementById('search-input');
  const btnClearSearch = document.getElementById('btn-clear-search');

  searchInput.addEventListener('input', debounceSearch((e) => {
    searchQuery = e.target.value.trim();
    if (searchQuery) {
      btnClearSearch.classList.remove('hidden');
    } else {
      btnClearSearch.classList.add('hidden');
    }
    fetchEmails(false);
  }, 400));

  btnClearSearch.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    btnClearSearch.classList.add('hidden');
    fetchEmails(false);
    searchInput.focus();
  });

  // Bind Tab Click Events
  const tabReply = document.getElementById('tab-reply');
  const tabChat = document.getElementById('tab-chat');
  const panelReply = document.getElementById('panel-reply');
  const panelChat = document.getElementById('panel-chat');

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
    const loadMoreBtn = document.getElementById('btn-load-more');
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
    const newEmails = data.emails || [];

    if (append) {
      emailsList = emailsList.concat(newEmails);
    } else {
      emailsList = newEmails;
    }

    renderMailList(emailsList);
    
    // Refresh icons inside rendered content
    lucide.createIcons();
    
    if (append) {
      showToast(`이전 메일 ${newEmails.length}개를 추가로 불러왔습니다.`, 'success');
    } else {
      if (searchQuery) {
        showToast(`검색 조건에 맞는 메일을 ${totalMailCount}개 찾았습니다.`, 'success');
      } else {
        showToast(`성공적으로 메일 목록을 가져왔습니다. (총 ${totalMailCount}개)`, 'success');
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

  // Render individual email items
  emails.forEach(email => {
    const item = document.createElement('div');
    item.className = 'mail-item';
    item.dataset.id = email.id;
    if (selectedEmail && selectedEmail.id === email.id) {
      item.classList.add('active');
    }

    const displaySender = email.from.split('<')[0].trim() || email.from;
    const displayDate = formatDate(email.date);

    item.innerHTML = `
      <div class="mail-item-header">
        <span class="mail-sender" title="${email.from}">${displaySender}</span>
        <span class="mail-date">${displayDate}</span>
      </div>
      <div class="mail-subject" title="${email.subject}">${email.subject}</div>
    `;

    item.addEventListener('click', () => selectEmail(email.id));
    mailListContainer.appendChild(item);
  });

  // If there are more emails to fetch, append a "Load More" button at the bottom of the list
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
  } else if (emailsList.length > 0) {
    const endContainer = document.createElement('div');
    endContainer.className = 'list-end-marker';
    endContainer.innerHTML = `<span>마지막 메일입니다.</span>`;
    mailListContainer.appendChild(endContainer);
  }
}

// Select and Fetch Single Email Detail
async function selectEmail(id) {
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
  document.getElementById('workspace-panel').classList.remove('hidden');
  
  // Disable draft box on new selection
  document.getElementById('draft-box').classList.add('disabled');
  document.getElementById('reply-guide').value = '';
  document.getElementById('draft-to').value = '';
  document.getElementById('draft-cc').value = '';
  document.getElementById('draft-subject').value = '';
  document.getElementById('draft-body').value = '';

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
    
    // Pre-populate recipient To and clear CC
    document.getElementById('draft-to').value = extractEmailAddress(data.from);
    document.getElementById('draft-cc').value = '';

    // Set header info
    document.getElementById('detail-subject').textContent = data.subject || '(제목 없음)';
    document.getElementById('detail-from').textContent = data.from || '';
    document.getElementById('detail-to').textContent = data.to || '';
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
  
  if (!selectedEmail) {
    showToast('답장을 작성할 메일을 먼저 선택해주세요.', 'error');
    return;
  }

  if (!guideText) {
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

    const response = await fetch('/api/generate-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        originalEmail: minimalEmail,
        replyGuide: guideText
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '답장 생성에 실패했습니다.');
    }

    // Set draft box inputs
    document.getElementById('draft-subject').value = data.subject || `Re: ${selectedEmail.subject}`;
    document.getElementById('draft-body').value = data.body || '';

    // Enable draft panel
    document.getElementById('draft-box').classList.remove('disabled');
    showToast('AI가 성공적으로 메일 초안을 다듬었습니다!', 'success');

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
        body: body
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '메일 발송에 실패했습니다.');
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
