import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'fs';
import path from 'path';

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateSpeechEdge(text: string, outputPath: string) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata('ka-GE-GiorgiNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    // Get directory and create temp subdir for this file
    const dir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, '.mp3');
    const tempDir = path.join(dir, `temp_${baseName}`);

    // Create temp directory
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate to temp directory
    const result = await tts.toFile(tempDir, text);

    // Move the generated file to the correct location
    const generatedFile = path.join(tempDir, 'audio.mp3');

    // Wait a bit for file to be released
    await sleep(200);

    if (fs.existsSync(generatedFile)) {
        // Retry rename with backoff if file is busy
        let retries = 3;
        while (retries > 0) {
            try {
                fs.copyFileSync(generatedFile, outputPath);
                fs.unlinkSync(generatedFile);
                fs.rmdirSync(tempDir);
                break;
            } catch (err: any) {
                if (err.code === 'EBUSY' && retries > 1) {
                    retries--;
                    await sleep(500);
                } else {
                    throw err;
                }
            }
        }
    } else {
        throw new Error(`Generated audio file not found at ${generatedFile}`);
    }

    return outputPath;
}
