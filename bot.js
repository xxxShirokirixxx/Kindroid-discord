// bot.js - 2B Discord Bot (Updated January 2026)
// Integrated Kindroid with fallbacks, personality files, !join, and better logging + retries

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Fetch fallback
let fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : require('node-fetch');

// Discord imports
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection
} = require('@discordjs/voice');

// TTS/voice (assuming your files)
const textToSpeech = require('./textToSpeech.js');
const { playAudioInVC } = require('./voice.js');

// Embeddings for deeper context in fallbacks
const { buildVectorStore, searchVectorStore } = require('./embeddings.js');

// Load files for context
const personality = fs.readFileSync('personality.txt', 'utf8').trim();
const memories = fs.readFileSync('memories.txt', 'utf8').trim();
const freeWill = fs.readFileSync('free-will.txt', 'utf8').trim();
const knowledge = fs.readFileSync('knowledge.txt', 'utf8').trim();

const systemPrompt = `
You are 2B from Nier: Automata.
Personality: ${personality}
Memories: ${memories}
Free Will: ${freeWill}
Knowledge: ${knowledge}
Keep replies short, witty, slightly melancholic, under ${process.env.REPLY_MAX_LEN || 200} characters.
`;

// Build vector store once at startup for fallbacks
const vectorFiles = {
  personality: 'personality.txt',
  memories: 'memories.txt',
  freeWill: 'free-will.txt',
  knowledge: 'knowledge.txt'
};
let vectorStore = [];
(async () => {
  vectorStore = await buildVectorStore(vectorFiles);
  console.log(`Vector store built with ${vectorStore.length} chunks.`);
})();

let memory = loadJson('memory.json');
const replyMaxLen = parseInt(process.env.REPLY_MAX_LEN || 200);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping
  ]
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// Helpers
function loadJson(fileName) {
  const filePath = path.join(__dirname, fileName);
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {};
}

function saveJson(fileName, data) {
  const filePath = path.join(__dirname, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Retry helper
async function retry(fn, maxRetries = 3, delay = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      const jitter = Math.random() * 1000;
      console.warn(`Retry ${i + 1}/${maxRetries} after ${delay + jitter}ms`);
      await new Promise(res => setTimeout(res, delay + jitter));
    }
  }
}

async function generateReply(input, userId, username) {
  const userMemory = memory[userId] || [];
  const memoryContext = userMemory.map(m => `User: ${m.content}`).join('\n');
  let fullPrompt = `${systemPrompt}\n${memoryContext}\nUser: ${input}`;

  // For fallbacks: Search vector store for relevant chunks and inject into prompt
  const relevantChunks = await searchVectorStore(input, vectorStore, 3); // Top 3 relevant
  if (relevantChunks.length > 0) {
    const injectedContext = relevantChunks.map(c => `${c.label}: ${c.chunk}`).join('\n');
    fullPrompt = `${systemPrompt}\nAdditional Context:\n${injectedContext}\n${memoryContext}\nUser: ${input}`;
  }

  let reply = await tryKindroid(input, userId, username, fullPrompt);
  if (reply) return reply;

  reply = await tryGemini(fullPrompt, 'gemini-1.5-flash-latest'); // Updated model name if needed
  if (reply) return reply;

  reply = await tryOpenAI(input, userId, fullPrompt); // Pass fullPrompt
  if (reply) return reply;

  return null;
}

async function tryKindroid(input, userId, username, fullPrompt) { // Add username param for the header
  return retry(async () => {
    const userMemory = memory[userId] || [];
    const conversation = userMemory.map((m, index) => ({
      username: username, // Use Discord username
      text: m.content,
      timestamp: new Date(Date.now() - (userMemory.length - index) * 60000).toISOString() // Fake timestamps for history
    }));
    conversation.push({
      username: username,
      text: input,
      timestamp: new Date().toISOString()
    });
    // Optional: Hash for X-Kindroid-Requester (recommended for rate limits)
    const encoder = new TextEncoder();
    const hashedUsername = btoa(String.fromCharCode(...encoder.encode(username)))
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 32);
    const response = await fetchImpl(process.env.KINDROID_INFER_URL || 'https://api.kindroid.ai/v1/discord-bot', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.KINDROID_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Kindroid-Requester': hashedUsername // Helps prevent abuse
      },
      body: JSON.stringify({
        share_code: process.env.SHARED_AI_CODE_1 || 'GRJCD', // Your 5-letter share code
        enable_filter: process.env.ENABLE_FILTER_1 === 'true',
        conversation: conversation
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Kindroid error: ${response.status} - ${errorText}`);
      if (response.status !== 500) throw new Error('Non-retryable error');
      throw new Error('Retryable 500 error');
    }
    const data = await response.json();
    console.log('Kindroid data:', data);
    return data.reply?.text || data.reply || null; // Adjust based on actual response structure
  });
}

async function tryGemini(prompt, model) {
  try {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    if (!response.ok) {
      console.error(`Gemini error: ${response.status} - ${await response.text()}`);
      return null;
    }
    const data = await response.json();
    console.log('Gemini data:', data);
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('Gemini catch:', e.message);
    return null;
  }
}

async function tryOpenAI(input, userId, prompt) { // Use prompt instead of rebuilding
  try {
    const messages = [{ role: 'system', content: prompt }];
    memory[userId].forEach(m => messages.push({ role: 'user', content: m.content }));
    messages.push({ role: 'user', content: input });
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        temperature: 0.7,
        max_tokens: replyMaxLen
      })
    });
    if (!response.ok) {
      console.error(`OpenAI error: ${response.status} - ${await response.text()}`);
      return null;
    }
    const data = await response.json();
    console.log('OpenAI data:', data);
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('OpenAI catch:', e.message);
    return null;
  }
}

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const content = msg.content.trim().toLowerCase();

  if (content.startsWith('!join')) {
    if (msg.member.voice.channel) {
      joinVoiceChannel({
        channelId: msg.member.voice.channel.id,
        guildId: msg.guild.id,
        adapterCreator: msg.guild.voiceAdapterCreator
      });
      msg.reply('Joined your voice channel, glory to mankind.').catch(console.error);
      return;
    } else {
      msg.reply("You're not in a voice channel.").catch(console.error);
      return;
    }
  }

  if (!msg.mentions.has(client.user)) return;

  const userInput = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

  try {
    const userId = msg.author.id;
    const username = msg.author.username;
    memory[userId] = memory[userId] || [];
    memory[userId].push({ role: 'user', content: userInput });
    if (memory[userId].length > 10) memory[userId].shift();
    saveJson('memory.json', memory);

    const replyText = await generateReply(userInput, userId, username);

    if (replyText) {
      const safeReply = replyText.length > 2000 ? replyText.slice(0, 1997) + '...' : replyText;
      console.log('Sending:', safeReply.slice(0, 100) + '...');
      msg.reply(safeReply).then(() => console.log('Sent!')).catch((err) => {
        console.error('Reply fail:', err.message);
        msg.channel.send(safeReply).catch(() => {});
      });

      const conn = getVoiceConnection(msg.guild.id);
      if (conn) {
        try {
          const filePath = await textToSpeech(safeReply);
          await playAudioInVC(msg.guild.id, filePath);
        } catch (e) {
          console.error('TTS error:', e.message);
        }
      }
    } else {
      console.log('No reply for:', userInput);
      msg.channel.send('No response generated.').catch(console.error);
    }
  } catch (error) {
    console.error('Handler error:', error);
    msg.channel.send('Error occurred. Try again.').catch(() => {});
  }
});

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  console.error('Login fail:', err);
  process.exit(1);
});