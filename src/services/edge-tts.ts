import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'fs';
import path from 'path';

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function createTTSInstance(): Promise<MsEdgeTTS> {
    const tts = new MsEdgeTTS();
    await tts.setMetadata('ka-GE-GiorgiNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    return tts;
}

async function moveFile(generatedFile: string, outputPath: string, tempDir: string) {
    await sleep(200);
    if (!fs.existsSync(generatedFile)) {
        throw new Error(`Generated audio file not found at ${generatedFile}`);
    }
    let retries = 3;
    while (retries > 0) {
        try {
            fs.copyFileSync(generatedFile, outputPath);
            fs.unlinkSync(generatedFile);
            fs.rmdirSync(tempDir);
            return;
        } catch (err: any) {
            if (err.code === 'EBUSY' && retries > 1) {
                retries--;
                await sleep(500);
            } else {
                throw err;
            }
        }
    }
}

export async function generateSpeechEdgeWithInstance(tts: MsEdgeTTS, text: string, outputPath: string) {
    const dir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, '.mp3');
    const tempDir = path.join(dir, `temp_${baseName}`);

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    await tts.toFile(tempDir, text);
    await moveFile(path.join(tempDir, 'audio.mp3'), outputPath, tempDir);
    return outputPath;
}

export async function generateSpeechEdge(text: string, outputPath: string) {
    const tts = await createTTSInstance();
    return generateSpeechEdgeWithInstance(tts, text, outputPath);
}
