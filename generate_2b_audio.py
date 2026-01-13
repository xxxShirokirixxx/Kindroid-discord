import sys
import numpy as np
from scipy.io import wavfile
from TTS.api import TTS

def generate_audio(text, output_file):
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
    
    # Generate waveform (float32, mono, ~24kHz)
    waveform = tts.tts(
        text=text,
        speaker_wav="/Users/kirishiro/Downloads/2b_sample.wav",
        language="en"
    )
    
    waveform = np.array(waveform, dtype=np.float32)
    
    # Normalize to [-1, 1]
    if np.max(np.abs(waveform)) > 0:
        waveform /= np.max(np.abs(waveform))
    
    # Resample to 48kHz (linear interpolation)
    orig_sr = tts.synthesizer.output_sample_rate  # usually 24000
    if orig_sr != 48000:
        new_length = int(len(waveform) * 48000 / orig_sr)
        x_old = np.linspace(0, 1, len(waveform))
        x_new = np.linspace(0, 1, new_length)
        waveform = np.interp(x_new, x_old, waveform)
    
    # Force stereo by duplicating channel
    waveform_stereo = np.column_stack((waveform, waveform))
    
    # Convert to int16 PCM (-32768 to 32767)
    waveform_int16 = np.int16(waveform_stereo * 32767)
    
    # Save as 48kHz stereo 16-bit PCM WAV
    wavfile.write(output_file, 48000, waveform_int16)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python generate_2b_audio.py \"text to speak\" output.wav")
        sys.exit(1)
    
    text = sys.argv[1]
    output_file = sys.argv[2]
    generate_audio(text, output_file)
    print(f"Generated: {output_file}")