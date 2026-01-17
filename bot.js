// bot.js - 2B Discord Bot (Updated January 2026)
// Integrated Kindroid with fallbacks, personality files, !join/voice, free cloning, and better logging + retries

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const unzipper = require('unzipper');

// Fetch fallback
let fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : require('node-fetch');

// Discord imports
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');

// TTS/voice (updated for ElevenLabs cloning)
const textToSpeech = require('./textToSpeech.js');
const { playAudioInVC, speakInVC } = require('./voice.js');

// Embeddings for deeper context in fallbacks
const { buildVectorStore, searchVectorStore } = require('./embeddings.js');

// Download and unzip Vosk model if not present
const VOSK_MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const VOSK_MODEL_DIR = process.env.VOSK_MODEL_DIR || path.join(__dirname, 'vosk-model-small-en-us-0.15');

async function setupVoskModel() {
  if (fs.existsSync(VOSK_MODEL_DIR)) {
    console.log('Vosk model already exists.');
    return;
  }

  console.log('Downloading Vosk model...');
  const zipPath = path.join(__dirname, 'vosk-model.zip');

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    https.get(VOSK_MODEL_URL, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('Unzipping Vosk model...');
        fs.createReadStream(zipPath)
          .pipe(unzipper.Extract({ path: __dirname }))
          .on('close', () => {
            fs.unlinkSync(zipPath);  // Clean up zip
            console.log('Vosk model ready.');
            resolve();
          })
          .on('error', (err) => {
            console.error('Unzip error:', err);
            reject(err);
          });
      });
    }).on('error', (err) => {
      fs.unlinkSync(zipPath);
      console.error('Download error:', err);
      reject(err);
    });
  });
}

// Run setup on startup
(async () => {
  try {
    await setupVoskModel();
  } catch (err) {
    console.error('Vosk setup failed:', err);
  }
})();

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

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  if (msg.content.startsWith('!join')) {
    const channel = msg.member?.voice.channel;
    if (!channel) return msg.reply('Join a voice channel first.');

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: msg.guild.id,
      adapterCreator: msg.guild.voiceAdapterCreator,
    });

    connection.on('error', console.error);
    return msg.reply('Joined voice channel.');
  }

  if (msg.content.startsWith('!leave')) {
    const connection = getVoiceConnection(msg.guild.id);
    if (connection) {
      connection.destroy();
      msg.reply('Left the voice channel.').catch(console.error);
    } else {
      msg.reply('Not in a voice channel.').catch(console.error);
    }
    return;
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

      const connection = getVoiceConnection(msg.guild.id);
      if (connection) {
        try {
          // Use standardized speakInVC with ElevenLabs
          await speakInVC(msg.guild.id, safeReply);
        } catch (e) {
          console.error('Voice cloning/TTS error:', e.message);
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

client.login(process.env.BOT_TOKEN_1).catch((err) => {
  console.error('Login fail:', err);
  process.exit(1);
});