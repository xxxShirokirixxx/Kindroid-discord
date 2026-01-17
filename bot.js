// bot.js - 2B Discord Bot (Updated January 2026)
// Integrated Kindroid with fallbacks, personality files, !join/voice, free cloning, and better logging + retries

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const unzipper = require('unzipper');

// Fetch fallback
let fetchImpl =
  typeof fetch !== 'undefined'
    ? fetch.bind(globalThis)
    : require('node-fetch');

// Discord imports
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
} = require('@discordjs/voice');

// TTS / voice
const { speakInVC } = require('./voice.js');

// Embeddings for fallback replies
const { buildVectorStore, searchVectorStore } = require('./embeddings.js');


// --------------------
// VOSK SETUP (AUTO-DOWNLOAD)
// --------------------

const VOSK_MODEL_URL =
  'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const VOSK_MODEL_DIR =
  process.env.VOSK_MODEL_DIR ||
  path.join(__dirname, 'vosk-model-small-en-us-0.15');

async function setupVoskModel() {
  if (fs.existsSync(VOSK_MODEL_DIR)) {
    console.log('Vosk model already exists.');
    return;
  }

  console.log('Downloading Vosk model...');
  const zipPath = path.join(__dirname, 'vosk-model.zip');

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    https
      .get(VOSK_MODEL_URL, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('Unzipping Vosk model...');
          fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: __dirname }))
            .on('close', () => {
              fs.unlinkSync(zipPath);
              console.log('Vosk model ready.');
              resolve();
            })
            .on('error', reject);
        });
      })
      .on('error', reject);
  });
}

(async () => {
  try {
    await setupVoskModel();
  } catch (err) {
    console.error('Vosk setup failed:', err);
  }
})();


// --------------------
// CONTEXT FILES
// --------------------

const personality = fs.readFileSync('personality.txt', 'utf8').trim();
const memories = fs.readFileSync('memories.txt', 'utf8').trim();
const freeWill = fs.readFileSync('free-will.txt', 'utf8').trim();
const knowledge = fs.readFileSync('knowledge.txt', 'utf8').trim();

const replyMaxLen = parseInt(process.env.REPLY_MAX_LEN || 200);


// --------------------
// VECTOR STORE
// --------------------

const vectorFiles = {
  personality: 'personality.txt',
  memories: 'memories.txt',
  freeWill: 'free-will.txt',
  knowledge: 'knowledge.txt',
};

let vectorStore = [];

(async () => {
  vectorStore = await buildVectorStore(vectorFiles);
  console.log(`Vector store built with ${vectorStore.length} chunks.`);
})();


// --------------------
// MEMORY
// --------------------

function loadJson(file) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let memory = loadJson('memory.json');


// --------------------
// REPLY GENERATION (🔥 FIX)
// --------------------

async function generateReply(userInput, userId, username) {
  // 1️⃣ Kindroid first
  try {
    if (process.env.KINDROID_API_KEY && process.env.KINDROID_INFER_URL) {
      const res = await axios.post(
        process.env.KINDROID_INFER_URL,
        {
          message: userInput,
          user_id: userId,
          username: username,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.KINDROID_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      if (res.data?.reply) {
        return res.data.reply.slice(0, replyMaxLen);
      }
    }
  } catch (err) {
    console.warn('⚠️ Kindroid failed, falling back:', err.message);
  }

  // 2️⃣ Vector fallback
  try {
    const results = await searchVectorStore(userInput, vectorStore, 3);
    if (results?.length) {
      return results
        .map((r) => r.text)
        .join(' ')
        .slice(0, replyMaxLen);
    }
  } catch (err) {
    console.warn('⚠️ Vector fallback failed:', err.message);
  }

  // 3️⃣ Never crash
  return '…I don’t have an answer right now.';
}


// --------------------
// DISCORD CLIENT
// --------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});


// --------------------
// MESSAGE HANDLER
// --------------------

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  // Join VC
  if (msg.content.startsWith('!join')) {
    const channel = msg.member?.voice?.channel;
    if (!channel) return msg.reply('Join a voice channel first.');

    joinVoiceChannel({
      channelId: channel.id,
      guildId: msg.guild.id,
      adapterCreator: msg.guild.voiceAdapterCreator,
    });

    return msg.reply('Joined voice channel.');
  }

  // Leave VC
  if (msg.content.startsWith('!leave')) {
    const connection = getVoiceConnection(msg.guild.id);
    if (connection) {
      connection.destroy();
      return msg.reply('Left the voice channel.');
    }
    return msg.reply('Not in a voice channel.');
  }

  // Only respond when mentioned
  if (!msg.mentions.has(client.user)) return;

  const userInput = msg.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  try {
    const userId = msg.author.id;
    const username = msg.author.username;

    memory[userId] = memory[userId] || [];
    memory[userId].push({ role: 'user', content: userInput });
    if (memory[userId].length > 10) memory[userId].shift();
    saveJson('memory.json', memory);

    const replyText = await generateReply(userInput, userId, username);

    await msg.reply(replyText);

    const connection = getVoiceConnection(msg.guild.id);
    if (connection) {
      await speakInVC(msg.guild.id, replyText);
    }
  } catch (err) {
    console.error('Handler error:', err);
    msg.channel.send('Error occurred. Try again.').catch(() => {});
  }
});


// --------------------
// LOGIN
// --------------------

client.login(process.env.BOT_TOKEN_1).catch((err) => {
  console.error('Login fail:', err);
  process.exit(1);
});
