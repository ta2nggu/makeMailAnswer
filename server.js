require('dotenv').config();
const express = require('express');
const path = require('path');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const POP3Client = require('./pop3');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Gemini API
let genAI = null;
if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here') {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// Helper to get POP3 credentials from environment
const getPop3Config = () => {
  return {
    host: process.env.POP3_HOST || 'jmp.ktbizoffice.com',
    port: parseInt(process.env.POP3_PORT || '995', 10),
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASSWORD,
  };
};

const fs = require('fs');
const CACHE_FILE = path.join(__dirname, 'mail_cache.json');
const MAX_CACHE = 500;
const SYNC_THROTTLE_MS = 15000; // 15 seconds

let pop3Lock = Promise.resolve();
async function runWithPop3Lock(fn) {
  const nextLock = new Promise((resolve) => {
    pop3Lock.finally(resolve);
  });
  const currentLock = pop3Lock;
  pop3Lock = nextLock;
  await currentLock;
  return fn();
}

let emailCache = {};
let cachedMailList = [];
let lastSyncTime = 0;
let isSyncingBackground = false;

// Load cache from file
function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      emailCache = JSON.parse(data);
      console.log(`Loaded ${Object.keys(emailCache).length} cached mail headers.`);
    }
  } catch (err) {
    console.error('Failed to load mail cache:', err);
    emailCache = {};
  }
}

// Save cache to file
function saveCacheToFile() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(emailCache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save mail cache:', err);
  }
}

// Initial cache load
loadCacheFromFile();

// Synchronize mailbox headers
async function syncMailbox(force = false) {
  const now = Date.now();
  if (!force && now - lastSyncTime < SYNC_THROTTLE_MS && cachedMailList.length > 0) {
    return cachedMailList;
  }

  // Get current UIDL list
  const uidlMails = await runWithPop3Lock(async () => {
    const config = getPop3Config();
    if (!config.user || !config.password) {
      throw new Error('Mail credentials are not configured in .env file.');
    }
    const client = new POP3Client(config);
    await client.connect();
    await client.login();
    const uidlResponse = await client.getUidl();
    const lines = uidlResponse.split('\r\n');
    const serverMails = [];
    for (const line of lines) {
      const parts = line.trim().split(' ');
      if (parts.length >= 2) {
        const msgNum = parseInt(parts[0], 10);
        const uniqueId = parts[1];
        if (!isNaN(msgNum) && uniqueId) {
          serverMails.push({ msgNum, uniqueId });
        }
      }
    }
    await client.quit();
    return serverMails;
  });

  // Sort newest to oldest (msgNum descending)
  uidlMails.sort((a, b) => b.msgNum - a.msgNum);

  // Keep only the latest MAX_CACHE
  const targetMails = uidlMails.slice(0, MAX_CACHE);

  // Helper to rebuild active list from cache
  const rebuildList = () => {
    return targetMails.map(item => {
      const cached = emailCache[item.uniqueId];
      if (cached) {
        return {
          id: item.msgNum,
          uniqueId: item.uniqueId,
          subject: cached.subject,
          from: cached.from,
          date: cached.date
        };
      }
      return null;
    }).filter(Boolean);
  };

  cachedMailList = rebuildList();

  // Find missing emails in cache
  const missingMails = targetMails.filter(item => !emailCache[item.uniqueId]);

  if (missingMails.length > 0 && !isSyncingBackground) {
    // If cache is empty or has very few items, fetch first 50 synchronously for immediate response
    const syncImmediatelyCount = cachedMailList.length === 0 ? Math.min(50, missingMails.length) : 0;

    if (syncImmediatelyCount > 0) {
      console.log(`Syncing ${syncImmediatelyCount} mails synchronously...`);
      const immediateMails = missingMails.slice(0, syncImmediatelyCount);
      await runWithPop3Lock(async () => {
        const config = getPop3Config();
        const client = new POP3Client(config);
        await client.connect();
        await client.login();
        for (const item of immediateMails) {
          try {
            const rawHeader = await client.getHeader(item.msgNum);
            const parsed = await simpleParser(rawHeader);
            emailCache[item.uniqueId] = {
              subject: parsed.subject || '(No Subject)',
              from: parsed.from ? parsed.from.text : 'Unknown',
              date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            };
          } catch (err) {
            console.error(`Failed to fetch header for email #${item.msgNum}:`, err);
          }
        }
        await client.quit();
      });
      saveCacheToFile();
      cachedMailList = rebuildList();
    }

    // Background sync remaining emails
    const remainingMissing = missingMails.slice(syncImmediatelyCount);
    if (remainingMissing.length > 0) {
      isSyncingBackground = true;
      console.log(`Starting background sync for ${remainingMissing.length} emails...`);
      (async () => {
        try {
          const batchSize = 10;
          for (let i = 0; i < remainingMissing.length; i += batchSize) {
            const batch = remainingMissing.slice(i, i + batchSize);
            await runWithPop3Lock(async () => {
              const config = getPop3Config();
              const client = new POP3Client(config);
              await client.connect();
              await client.login();
              for (const item of batch) {
                try {
                  const rawHeader = await client.getHeader(item.msgNum);
                  const parsed = await simpleParser(rawHeader);
                  emailCache[item.uniqueId] = {
                    subject: parsed.subject || '(No Subject)',
                    from: parsed.from ? parsed.from.text : 'Unknown',
                    date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
                  };
                } catch (err) {
                  console.error(`Failed to fetch header in background:`, err);
                }
              }
              await client.quit();
            });
            saveCacheToFile();
            cachedMailList = rebuildList();
            await new Promise(r => setTimeout(r, 200));
          }
          console.log('Background sync completed.');
        } catch (err) {
          console.error('Background sync failed:', err);
        } finally {
          isSyncingBackground = false;
        }
      })();
    }
  }

  lastSyncTime = Date.now();
  return cachedMailList;
}

// API: Get recent email list
app.get('/api/emails', async (req, res) => {
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '10', 10);
  const search = (req.query.search || '').trim().toLowerCase();
  const forceRefresh = req.query.forceRefresh === 'true';

  try {
    const allEmails = await syncMailbox(forceRefresh);

    let filteredEmails = allEmails;
    if (search) {
      filteredEmails = allEmails.filter(email => 
        (email.subject && email.subject.toLowerCase().includes(search)) || 
        (email.from && email.from.toLowerCase().includes(search))
      );
    }

    const count = filteredEmails.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedEmails = filteredEmails.slice(startIndex, endIndex);

    res.json({
      count,
      page,
      limit,
      emails: paginatedEmails,
      isSyncing: isSyncingBackground
    });
  } catch (error) {
    console.error('POP3 API Error:', error);
    res.status(500).json({ error: `Mailbox Access Error: ${error.message}` });
  }
});

// API: Get detailed email body
app.get('/api/emails/:id', async (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  
  try {
    const data = await runWithPop3Lock(async () => {
      const config = getPop3Config();
      if (!config.user || !config.password) {
        throw new Error('Mail credentials are not configured in .env file.');
      }
      const client = new POP3Client(config);
      await client.connect();
      await client.login();
      
      const rawMail = await client.getMail(emailId);
      const parsed = await simpleParser(rawMail);
      await client.quit();

      return {
        id: emailId,
        subject: parsed.subject || '(No Subject)',
        from: parsed.from ? parsed.from.text : 'Unknown',
        to: parsed.to ? parsed.to.text : 'Unknown',
        date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
        text: parsed.text || '',
        html: parsed.html || parsed.text || '',
      };
    });

    res.json(data);
  } catch (error) {
    console.error('POP3 Detail Error:', error);
    res.status(500).json({ error: `Failed to fetch email details: ${error.message}` });
  }
});

// API: Generate reply using Gemini AI
app.post('/api/generate-reply', async (req, res) => {
  const { originalEmail, replyGuide } = req.body;

  if (!genAI) {
    return res.status(400).json({ error: 'Gemini API Key is missing or invalid. Please check your .env file.' });
  }

  if (!originalEmail || !replyGuide) {
    return res.status(400).json({ error: 'Missing originalEmail or replyGuide fields.' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });

    const prompt = `
You are a professional business email assistant.
Your task is to write a polite, professional, and refined reply to the email provided below based on the user's reply guide.

[Original Email Header]
From: ${originalEmail.from}
Subject: ${originalEmail.subject}
Date: ${originalEmail.date}

[Original Email Body]
${originalEmail.text || originalEmail.html}

[User's Reply Instruction/Draft]
${replyGuide}

Instructions:
1. Write the response in natural, polite Korean business style (한국어 비즈니스 이메일 톤앤매너).
2. Fix all grammatical issues and refine rough expressions from the user's reply guide, ensuring it matches the context of the original email.
3. The body of the generated response MUST strictly adhere to the following signature template format (do not omit greetings and signature):
안녕하세요.
로젠 정보전략팀 김태영입니다.

[Refined message body goes here]

감사합니다.

로젠택배 정보전략팀 김태영 책임

4. Output ONLY the reply email subject (prefixed with "Re: ") and the structured reply body.
5. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();

    // Clean up potential markdown formatting block if the AI returned it despite the instruction
    if (text.startsWith('```json')) {
      text = text.substring(7);
    } else if (text.startsWith('```')) {
      text = text.substring(3);
    }
    if (text.endsWith('```')) {
      text = text.substring(0, text.length - 3);
    }
    text = text.trim();

    const replyData = JSON.parse(text);
    res.json(replyData);
  } catch (error) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: `AI Draft Generation Error: ${error.message}` });
  }
});

// API: Chat with AI to understand mail content
app.post('/api/mail-chat', async (req, res) => {
  const { originalEmail, message, history } = req.body;

  if (!genAI) {
    return res.status(400).json({ error: 'Gemini API Key is missing or invalid. Please check your .env file.' });
  }

  if (!originalEmail || !message) {
    return res.status(400).json({ error: 'Missing originalEmail or message fields.' });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      systemInstruction: `당신은 사용자가 수신한 비즈니스 이메일을 분석하고 설명해주는 친절한 AI 조수입니다. 
다음은 분석할 이메일 정보입니다:
보낸 사람: ${originalEmail.from}
제목: ${originalEmail.subject}
날짜: ${originalEmail.date}
본문:
${originalEmail.text || originalEmail.html}

사용자가 이 메일의 문맥, 의도, 어려운 비즈니스 용어, 제안된 일정, 조치 필요 사항 등에 대해 질문하면 정확하고 이해하기 쉽게 설명해 주세요. 항상 공손하고 명확한 비즈니스 톤으로 한국어로 응답하세요.`,
    });

    const chat = model.startChat({
      history: history || [],
    });

    const result = await chat.sendMessage(message);
    const replyText = result.response.text();

    res.json({ reply: replyText });
  } catch (error) {
    console.error('Gemini Chat Error:', error);
    res.status(500).json({ error: `AI Chat Error: ${error.message}` });
  }
});

// API: Generate messenger reply and advice using Gemini AI
app.post('/api/generate-messenger-reply', async (req, res) => {
  const { chatHistory, keywords } = req.body;

  if (!genAI) {
    return res.status(400).json({ error: 'Gemini API Key is missing or invalid. Please check your .env file.' });
  }

  if (!chatHistory && !keywords) {
    return res.status(400).json({ error: '대화 내역이나 답변 키워드 중 최소 하나는 입력해 주세요.' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });

    const prompt = `
당신은 사내 메신저 대화 분석 및 답변 작성을 돕는 비즈니스 커뮤니케이션 코치입니다.
사용자가 대화 내역(chatHistory)과 답변하고 싶은 키워드/의도(keywords)를 제공하면, 다음 보낼 메신저 답장을 작성하고 이에 대한 조언을 제공해야 합니다.

[사용자가 제공한 대화 내역]
${chatHistory || '(이전 대화 내역 없음 - 상대방에게 처음 대화를 선제적으로 건네는 상황입니다.)'}

[사용자가 원하는 답변 키워드 및 의도]
${keywords || '(특별히 지정된 키워드 없음. 대화 맥락에 따라 가장 자연스러운 답변 작성)'}

지침:
1. 대화 내역(chatHistory)이 주어졌다면 맥락을 분석하여 상대방의 소속/이름/직급에 맞는 답변을 제안하세요.
2. 대화 내역(chatHistory)이 비어있다면, 대화가 없는 상태에서 선제적으로 상대방에게 대화를 시작(첫 인사 및 용건 제시)하는 상황입니다. [사용자가 원하는 답변 키워드 및 의도]에 담긴 용건을 바탕으로 자연스럽고 정중하게 말을 거는 메시지를 제안하세요.
3. 사용자가 입력한 [답변 키워드 및 의도]를 메신저 대화에 적절한 어조로 구체화하여 답변 초안들을 작성하세요.
4. 메신저는 이메일보다 비교적 즉각적이고 짧은 호흡으로 진행되므로, 지나치게 길거나 이메일 양식(예: 서명 등)을 강제하지 말고 자연스러운 메신저 어조로 작성해 주세요.
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
}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();

    // Clean up potential markdown formatting block
    if (text.startsWith('```json')) {
      text = text.substring(7);
    } else if (text.startsWith('```')) {
      text = text.substring(3);
    }
    if (text.endsWith('```')) {
      text = text.substring(0, text.length - 3);
    }
    text = text.trim();

    const replyData = JSON.parse(text);
    res.json(replyData);
  } catch (error) {
    console.error('Gemini Messenger AI Error:', error);
    res.status(500).json({ error: `AI Draft Generation Error: ${error.message}` });
  }
});

// API: Send email (SMTP)
app.post('/api/send-reply', async (req, res) => {
  const { to, cc, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Missing to, subject, or body fields.' });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'jmp.ktbizoffice.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: true, // true for SSL/TLS, false for STARTTLS
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1', // Allow older TLS versions if KT Biz Office uses them
    },
    debug: true, // Output SMTP logs in terminal
    logger: true // Output SMTP logs in terminal
  });

  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_USER,
      to,
      cc: cc || undefined, // Send CC only if provided
      subject,
      text: body,
    });

    res.json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('SMTP Error:', error);
    res.status(500).json({ error: `SMTP Send Error: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`AI Mail Assistant server running at http://localhost:${PORT}`);
});
