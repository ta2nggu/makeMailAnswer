require('dotenv').config();
const express = require('express');
const path = require('path');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const POP3Client = require('./pop3');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API: Serve signature banner image
app.get('/api/signature-banner', (req, res) => {
  const bannerPath = 'C:\\Users\\kty\\Pictures\\hotbanner.jpg';
  if (fs.existsSync(bannerPath)) {
    res.sendFile(bannerPath);
  } else {
    res.status(404).send('Banner not found');
  }
});

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
let maxCacheSize = 500;
let totalServerMailsCount = 0;
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
let msgNumToUidMap = {};
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
  totalServerMailsCount = uidlMails.length;

  // Update msgNum to uniqueId map
  msgNumToUidMap = {};
  for (const item of uidlMails) {
    msgNumToUidMap[item.msgNum] = item.uniqueId;
  }

  // Keep targetMails up to maxCacheSize
  const targetMails = uidlMails.slice(0, maxCacheSize);

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
    // If cache has missing items, fetch first batch (up to 50) synchronously if user requested force refresh or cache is small
    const syncImmediatelyCount = (force || cachedMailList.length < 50) ? Math.min(50, missingMails.length) : 0;

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

// API: Expand or set mail cache limit
app.post('/api/emails/load-more-server', async (req, res) => {
  try {
    const amount = req.body.amount;
    const targetSize = req.body.targetSize;
    
    if (targetSize === 'all') {
      maxCacheSize = Math.max(totalServerMailsCount || 5000, 5000);
    } else if (targetSize) {
      maxCacheSize = parseInt(targetSize, 10);
    } else {
      maxCacheSize += parseInt(amount || '500', 10);
    }
    
    console.log(`Updated maxCacheSize to ${maxCacheSize}`);
    const allEmails = await syncMailbox(true);
    res.json({
      success: true,
      maxCacheSize,
      serverTotalCount: totalServerMailsCount,
      cachedCount: allEmails.length,
      isSyncing: isSyncingBackground
    });
  } catch (error) {
    console.error('Failed to load more from server:', error);
    res.status(500).json({ error: `Failed to fetch more emails from POP3 server: ${error.message}` });
  }
});

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
      isSyncing: isSyncingBackground,
      serverTotalCount: totalServerMailsCount,
      maxCacheSize
    });
  } catch (error) {
    console.error('POP3 API Error:', error);
    res.status(500).json({ error: `Mailbox Access Error: ${error.message}` });
  }
});

// In-memory or temporary store for email attachments
const emailAttachmentsCache = {};

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

      // Extract attachments metadata & cache buffers for download
      const attachments = (parsed.attachments || []).map((att, index) => {
        return {
          id: index,
          filename: att.filename || `attachment_${index + 1}`,
          contentType: att.contentType,
          size: att.size || (att.content ? att.content.length : 0),
        };
      });

      // Cache attachment buffers in memory for this email
      if (parsed.attachments && parsed.attachments.length > 0) {
        emailAttachmentsCache[emailId] = parsed.attachments;
      } else {
        delete emailAttachmentsCache[emailId];
      }

      return {
        id: emailId,
        uniqueId: msgNumToUidMap[emailId] || '',
        subject: parsed.subject || '(No Subject)',
        from: parsed.from ? parsed.from.text : 'Unknown',
        to: parsed.to ? parsed.to.text : 'Unknown',
        cc: parsed.cc ? parsed.cc.text : '',
        date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
        text: parsed.text || '',
        html: parsed.html || parsed.text || '',
        attachments: attachments
      };
    });

    res.json(data);
  } catch (error) {
    console.error('POP3 Detail Error:', error);
    res.status(500).json({ error: `Failed to fetch email details: ${error.message}` });
  }
});

// API: Download email attachment
app.get('/api/emails/:id/attachments/:attId', async (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  const attIndex = parseInt(req.params.attId, 10);

  try {
    let attachments = emailAttachmentsCache[emailId];
    if (!attachments) {
      // Re-fetch email from POP3 if not in cache
      await runWithPop3Lock(async () => {
        const config = getPop3Config();
        const client = new POP3Client(config);
        await client.connect();
        await client.login();
        const rawMail = await client.getMail(emailId);
        const parsed = await simpleParser(rawMail);
        await client.quit();
        if (parsed.attachments && parsed.attachments.length > 0) {
          emailAttachmentsCache[emailId] = parsed.attachments;
          attachments = parsed.attachments;
        }
      });
    }

    if (!attachments || !attachments[attIndex]) {
      return res.status(404).send('Attachment not found');
    }

    const att = attachments[attIndex];
    const filename = att.filename || `attachment_${attIndex + 1}`;

    res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
    // Encode filename for Content-Disposition in UTF-8
    const encodedFilename = encodeURIComponent(filename);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
    if (att.size) {
      res.setHeader('Content-Length', att.size);
    }
    res.send(att.content);
  } catch (err) {
    console.error('Attachment download error:', err);
    res.status(500).send(`Failed to download attachment: ${err.message}`);
  }
});

// API: Get default prompt templates
app.get('/api/default-prompts', (req, res) => {
  res.json({
    emailPromptTemplate: `You are a professional business email assistant and editor.
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
From: {{from}}
Subject: {{subject}}
Date: {{date}}

[Original Email Body]
{{text}}

[User's Reply Instruction/Keywords]
{{replyGuide}}

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
6. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.`,
    newEmailPromptTemplate: `You are a professional business email assistant.
Your task is to compose a polite, professional, and well-structured Korean business email from scratch (신규 메일 최초 발송) based on the user's requirements.

CRITICAL INSTRUCTION:
- PRESERVE ALL DETAILS, FACTS, DATES, NUMBERS, AND REQUESTS from the user's guide without omitting or distorting anything.
- Act as a professional business writer & formatter: refine rough phrasing, structure the email clearly, and adhere to standard Korean business email etiquette.

[Recipient Info / Context]
{{recipientInfo}}

[Subject Keyword / Topic]
{{subjectHint}}

[User's Message & Core Points]
{{mailContentGuide}}

Instructions:
1. Write in polite, respectful, and natural Korean business email tone (한국어 비즈니스 이메일 톤앤매너).
2. Propose a clear, professional, and concise subject line appropriate for the email topic (do NOT include "Re:").
3. The body MUST strictly adhere to the following structure and signature format:
안녕하세요. [수신자 호칭/직급 반영 (예: OOO 과장님/담당자님, 정보가 없으면 생략)]
로젠 정보전략팀 김태영입니다.

[Refined and well-structured message body: clear context, core message, dates, action requests]

감사합니다.

로젠택배 정보전략팀 김태영 책임

4. Fix all grammatical errors and polish into executive-level professional wording.
5. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.`,
    messengerPromptTemplate: `당신은 사내 메신저 대화 분석 및 답변 작성을 돕는 비즈니스 커뮤니케이션 코치입니다.
사용자가 대화 내역(chatHistory)과 답변하고 싶은 키워드/의도(keywords)를 제공하면, 다음 보낼 메신저 답장을 작성하고 이에 대한 조언을 제공해야 합니다.

핵심 지침 (내용 유지 & 규격 다듬기):
- 사용자가 입력한 [답변 키워드 및 의도]의 핵심 내용, 조건, 일정, 전달 사항을 절대로 누락하거나 임의로 바꾸지 말고 최대한 원본 그대로 유지하세요.
- 당신의 주요 역할은 사용자가 작성한 입력 내용을 사내 메신저 규격과 정중한 어조에 맞게 매끄럽게 다듬고 문법/오탈자를 교정해 주는 것입니다.

[사용자가 제공한 대화 내역]
{{chatHistory}}

[사용자가 원하는 답변 키워드 및 의도]
{{keywords}}

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
}`
  });
});

// API: Generate reply using Gemini AI
app.post('/api/generate-reply', async (req, res) => {
  const { originalEmail, replyGuide, customPrompt } = req.body;

  if (!genAI) {
    return res.status(400).json({ error: 'Gemini API Key is missing or invalid. Please check your .env file.' });
  }

  if (!customPrompt && (!originalEmail || !replyGuide)) {
    return res.status(400).json({ error: 'Missing originalEmail or replyGuide fields.' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });

    let prompt = customPrompt;
    if (!prompt) {
      prompt = `
You are a professional business email assistant and editor.
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
From: ${originalEmail.from}
Subject: ${originalEmail.subject}
Date: ${originalEmail.date}

[Original Email Body]
${originalEmail.text || originalEmail.html}

[User's Reply Instruction/Keywords]
${replyGuide}

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
6. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.
`;
    }

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

// API: Generate new business email from scratch using Gemini AI
app.post('/api/generate-new-mail', async (req, res) => {
  const { recipientInfo, subjectHint, mailContentGuide, customPrompt } = req.body;

  if (!genAI) {
    return res.status(400).json({ error: 'Gemini API Key is missing or invalid. Please check your .env file.' });
  }

  if (!customPrompt && !mailContentGuide && !subjectHint) {
    return res.status(400).json({ error: '메일 작성 요점이나 제목 키워드를 입력해 주세요.' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });

    let prompt = customPrompt;
    if (!prompt) {
      prompt = `
You are a professional business email assistant.
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
5. Format the output in JSON format with keys "subject" and "body". Do not include markdown wraps (like \`\`\`json) in your raw response. Just return the JSON object directly.
`;
    }

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

    const mailData = JSON.parse(text);
    res.json(mailData);
  } catch (error) {
    console.error('Gemini New Mail API Error:', error);
    res.status(500).json({ error: `AI New Mail Generation Error: ${error.message}` });
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
  const { chatHistory, keywords, customPrompt } = req.body;

  if (!genAI) {
    return res.status(400).json({ error: 'Gemini API Key is missing or invalid. Please check your .env file.' });
  }

  if (!customPrompt && !chatHistory && !keywords) {
    return res.status(400).json({ error: '대화 내역이나 답변 키워드 중 최소 하나는 입력해 주세요.' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });

    let prompt = customPrompt;
    if (!prompt) {
      prompt = `
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
    }

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

// API: Send email (SMTP) - supports reply, new email, attachments, and clipboard inline images
const handleSendEmail = async (req, res) => {
  const { to, cc, subject, body, attachments, inlineImages } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Missing to, subject, or body fields.' });
  }

  // Ensure default CC taeyoung@ilogen.com is present if not already included
  let finalCc = cc ? cc.trim() : '';
  const defaultCc = 'taeyoung@ilogen.com';
  if (finalCc) {
    const list = finalCc.split(',').map(s => s.trim()).filter(Boolean);
    const hasDefault = list.some(addr => addr.toLowerCase().includes(defaultCc.toLowerCase()));
    if (!hasDefault) {
      list.push(defaultCc);
    }
    finalCc = list.join(', ');
  } else {
    finalCc = defaultCc;
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
    const mailAttachments = [];

    // 1. Signature banner inline attachment
    const bannerPath = 'C:\\Users\\kty\\Pictures\\hotbanner.jpg';
    const bannerExists = fs.existsSync(bannerPath);
    let bannerHtml = '';
    if (bannerExists) {
      mailAttachments.push({
        filename: 'hotbanner.jpg',
        path: bannerPath,
        cid: 'signature-hotbanner' // cid matching HTML img src
      });
      bannerHtml = `
        <div style="margin-top: 20px; margin-bottom: 20px;">
          <a href="https://bit.ly/ilogenemail" target="_blank" rel="noopener noreferrer">
            <img src="cid:signature-hotbanner" alt="Logen Banner" style="max-width: 100%; border: 0; display: block;" />
          </a>
        </div>
      `;
    }

    // 2. Clipboard pasted inline images (CID embedding)
    const validInlineImages = Array.isArray(inlineImages) ? inlineImages : [];
    validInlineImages.forEach((img, idx) => {
      if (img && img.data && img.cid) {
        // data format: "data:image/png;base64,....."
        const base64Data = img.data.replace(/^data:image\/\w+;base64,/, '');
        mailAttachments.push({
          filename: img.filename || `pasted_image_${idx + 1}.png`,
          content: Buffer.from(base64Data, 'base64'),
          cid: img.cid,
          contentType: img.contentType || 'image/png'
        });
      }
    });

    // 3. User document / file attachments (docx, xlsx, pdf, zip, etc.)
    const userAttachments = Array.isArray(attachments) ? attachments : [];
    userAttachments.forEach((file) => {
      if (file && file.filename && file.data) {
        // data format: base64 string
        const base64Data = file.data.includes('base64,') ? file.data.split('base64,')[1] : file.data;
        mailAttachments.push({
          filename: file.filename,
          content: Buffer.from(base64Data, 'base64'),
          contentType: file.contentType || undefined
        });
      }
    });

    // Helper to format text with preserved newlines and replacement for inline image placeholders
    const formatTextToHtml = (str) => {
      let escaped = str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      // Replace inline image tokens: [이미지: image_cid_...] -> <div style="margin: 12px 0;"><img src="cid:..." style="max-width:100%; border-radius:6px; box-shadow:0 1px 3px rgba(0,0,0,0.1);" /></div>
      validInlineImages.forEach(img => {
        const tokenEscaped = `[이미지: ${img.cid}]`;
        const imgTag = `<div style="margin: 12px 0;"><img src="cid:${img.cid}" alt="첨부 이미지" style="max-width: 100%; height: auto; border-radius: 6px; border: 1px solid #e2e8f0; display: block;" /></div>`;
        escaped = escaped.split(tokenEscaped).join(imgTag);
      });

      return escaped;
    };

    // Check if body has an original message section (e.g. reply history)
    const quoteDivider = '----- Original Message -----';
    let htmlBody = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b;">`;

    if (body.includes(quoteDivider)) {
      const parts = body.split(quoteDivider);
      const myReplyPart = parts[0];
      const historyPart = parts.slice(1).join(quoteDivider);

      htmlBody += `<div>${formatTextToHtml(myReplyPart)}</div>`;
      if (bannerHtml) {
        htmlBody += bannerHtml;
      }
      htmlBody += `<div style="margin-top: 15px; border-top: 1px solid #cbd5e1; padding-top: 12px; color: #475569;">
        <span style="font-weight: bold; color: #64748b;">----- Original Message -----</span>
        <div>${formatTextToHtml(historyPart)}</div>
      </div>`;
    } else {
      // Normal new email without quote history
      htmlBody += `<div>${formatTextToHtml(body)}</div>`;
      if (bannerHtml) {
        htmlBody += bannerHtml;
      }
    }

    htmlBody += `</div>`;

    const info = await transporter.sendMail({
      from: process.env.MAIL_USER,
      to,
      cc: finalCc || undefined,
      subject,
      text: body,
      html: htmlBody,
      attachments: mailAttachments.length > 0 ? mailAttachments : undefined
    });

    res.json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('SMTP Error:', error);
    res.status(500).json({ error: `SMTP Send Error: ${error.message}` });
  }
};

app.post('/api/send-reply', handleSendEmail);
app.post('/api/send-mail', handleSendEmail);

app.listen(PORT, () => {
  console.log(`AI Mail Assistant server running at http://localhost:${PORT}`);
});
