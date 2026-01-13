const { exec } = require('child_process');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

async function textToSpeech(text) {
  const outputFile = path.join(__dirname, `tts-${Date.now()}.mp3`);
  const pythonScript = path.join(__dirname, 'generate_2b_audio.py');
  const command = `source venv-tts-312/bin/activate && python "${pythonScript}" "${text.replace(/"/g, '\\"')}" "${outputFile}"`;

  try {
    const { stdout, stderr } = await execPromise(command, { shell: '/bin/bash' });
    console.log('Python TTS output:', stdout);
    if (stderr) console.warn('Python TTS warnings:', stderr);

    // Check if file was created
    if (!require('fs').existsSync(outputFile)) {
      throw new Error('MP3 file not generated');
    }

    return outputFile; // Return path to MP3 for playback
  } catch (err) {
    console.error('TTS failed:', err.message);
    throw err;
  }
}

module.exports = textToSpeech;
