// bot.js - 2B Discord Bot (Fully Stabilized January 2026)

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const unzipper = require('unzipper');

// Discord imports
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

// Voice / TTS
const { speakInVC } = require('./voice.js');

// Embeddings
const { buildVectorStore, searchVectorStore } = require('./embeddings.js');

// ---------- GLOBAL SAFETY (prevents Railway restart loops) ----------
process.on('unhandledRejection', (err) => {
  if (err?.message?.includes('No compatible encryption modes')) {
    console.warn('⚠️ Ignoring Discord voice encryption renegotiation error');
    return;
  }
  console.error('Unhandled rejection:', err);
});

// ---------- VOSK SETUP ----------
const VOSK_MODEL_URL =
  'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const VOSK_MODEL_DIR =
  process.env.VOSK_MODEL_DIR || path.join(__dirname, 'vosk-model-small-en-us-0.15');

async function setupVoskModel() {
  if (fs.existsSync(VOSK_MODEL_DIR)) {
    console.log('Vosk model already exists.');
    return;
  }

  console.log('Downloading Vosk model...');
  const zipPath = path.join(__dirname, 'vosk-model.zip');

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    https.get(VOSK_MODEL_URL, (res) => {
      res.pipe(file);
      file.on('finish', () => {
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
    }).on('error', reject);
  });
}

setupVoskModel().catch(console.error);

// ---------- LOAD CONTEXT FILES ----------
function readFileSafe(name) {
  try {
    return fs.readFileSync(name, 'utf8').trim();
  } catch {
    return '';
  }
}

const personality = readFileSafe('personality.txt');
const memories = readFileSafe('memories.txt');
const freeWill = readFileSafe('free-will.txt');
const knowledge = readFileSafe('knowledge.txt');

const replyMaxLen = parseInt(process.env.REPLY_MAX_LEN || '200', 10);

// ---------- VECTOR STORE ----------
let vectorStore = [];
(async () => {
  vectorStore = await buildVectorStore({
    personality: 'personality.txt',
    memories: 'memories.txt',
    freeWill: 'free-will.txt',
    knowledge: 'knowledge.txt',
  });
  console.log(`Vector store built with ${vectorStore.length} chunks.`);
})();

// ---------- MEMORY ----------
const memoryPath = path.join(__dirname, 'memory.json');
let memory = fs.existsSync(memoryPath)
  ? JSON.parse(fs.readFileSync(memoryPath, 'utf8'))
  : {};

function saveMemory() {
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
}

// ---------- DISCORD CLIENT ----------
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

// ---------- REPLY GENERATION ----------
async function generateReply(userText) {
  const safeText =
    typeof userText === 'string'
      ? userText
      : JSON.stringify(userText ?? '');

  try {
    const res = await axios.post(
      process.env.KINDROID_INFER_URL,
      {
        prompt: safeText,
        system: `You are 2B from NieR: Automata.
${personality}
${memories}
${freeWill}
${knowledge}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.KINDROID_API_KEY}`,
        },
        timeout: 20_000,
      }
    );

    return String(res.data?.text || '').trim();
  } catch (err) {
    console.warn('⚠️ Kindroid failed, falling back:', err.message);

    // 🔑 CRITICAL FIX: correct argument order + string safety
    const fallback = await searchVectorStore(
      safeText,
      vectorStore,
      1
    );

    return String(fallback?.[0]?.chunk || '…').trim();
  }
}

// ---------- MESSAGE HANDLER ----------
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  // Join voice
  if (msg.content === '!join') {
    const channel = msg.member?.voice.channel;
    if (!channel) return msg.reply('Join a voice channel first.');

    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      encryptionModes: [
        'aead_aes256_gcm_rtpsize',
        'aead_xchacha20_poly1305_rtpsize',
      ],
    });

    return msg.reply('…Connected.');
  }

  if (!msg.mentions.has(client.user)) return;

  const input = msg.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!input) return;

  memory[msg.author.id] = memory[msg.author.id] || [];
  memory[msg.author.id].push({ role: 'user', content: input });
  memory[msg.author.id] = memory[msg.author.id].slice(-10);
  saveMemory();

  let reply = await generateReply(input);

  // 🛡️ ABSOLUTE EMPTY PROTECTION
  if (!reply || !reply.trim()) reply = '…';

  reply = reply.slice(0, replyMaxLen);

  await msg.reply(reply);

  const vc = getVoiceConnection(msg.guild.id);
  if (vc && vc.state.status === VoiceConnectionStatus.Ready) {
    try {
      await speakInVC(msg.guild.id, reply);
    } catch (e) {
      console.warn('⚠️ Voice playback failed:', e.message);
    }
  }
});

// ---------- LOGIN ----------
client.login(process.env.BOT_TOKEN_1).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
