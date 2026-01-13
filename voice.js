const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require("@discordjs/voice");

const DEBUG = !!process.env.DEBUG;
const guildAudioPlayers = new Map();

function normalizeText(input) {
  if (typeof input === "string") return input;
  if (!input) return "";
  if (typeof input === "object" && typeof input.text === "string") return input.text;
  try { return String(input); } catch { return ""; }
}

async function playAudioInVC(guildId, filePath) {
  const conn = getVoiceConnection(guildId);
  if (!conn || conn.status === VoiceConnectionStatus.Destroyed) {
    console.warn("[Voice] No active connection for guild", guildId);
    return;
  }

  let player = guildAudioPlayers.get(guildId);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on("error", (err) => console.error("[Voice] Player error:", err.message));
    guildAudioPlayers.set(guildId, player);
  }

  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", filePath,
    "-acodec", "libmp3lame",
    "-f", "mp3",
    "-ar", "48000", "-ac", "2", "-ab", "128k", "pipe:1",
  ]);
  const resource = createAudioResource(ff.stdout, { inputType: 'mp3' });
  player.play(resource);
  conn.subscribe(player);

  return new Promise((resolve) => {
    player.once(AudioPlayerStatus.Idle, () => {
      if (!ff.killed) ff.kill();
      fs.unlink(filePath, () => resolve());
    });
  });
}

async function speakInVC(guildId, text) {
  const safeText = normalizeText(text);
  if (!guildId || !safeText) return;
  try {
    if (DEBUG) console.log("[Voice] speakInVC:", safeText);
    const filePath = await textToSpeech(safeText);
    await playAudioInVC(guildId, filePath);
  } catch (e) {
    console.error("[Voice] speakInVC error:", e);
  }
}

console.log("✅ voice.js (Local XTTS) loaded");
module.exports = { playAudioInVC, speakInVC };