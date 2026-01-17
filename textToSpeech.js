const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function textToSpeech(text) {
  const outputFile = path.join(__dirname, `tts-${Date.now()}.mp3`);

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text: text,
        model_id: 'eleven_multilingual_v2',  // Supports English for 2B; switch to v1 if needed
        voice_settings: {
          stability: 0.5,  // Adjust for 2B's calm tone (0-1)
          similarity_boost: 0.75  // High for cloning fidelity
        }
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    fs.writeFileSync(outputFile, response.data);
    return outputFile;  // Return path to MP3 for playback
  } catch (err) {
    console.error('ElevenLabs TTS failed:', err.message);
    throw err;
  }
}

module.exports = textToSpeech;