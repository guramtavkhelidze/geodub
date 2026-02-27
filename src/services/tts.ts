import { generateSpeechEdge } from './edge-tts';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const FFMPEG_PATH = 'C:\\Users\\Guram\\OneDrive\\Desktop\\Targmna\\ffmpeg-8.0.1-essentials_build\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
const FFPROBE_PATH = 'C:\\Users\\Guram\\OneDrive\\Desktop\\Targmna\\ffmpeg-8.0.1-essentials_build\\ffmpeg-8.0.1-essentials_build\\bin\\ffprobe.exe';

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

type ProgressCallback = (current: number, total: number, text: string, stage: string) => void;

export async function generateGeorgianAudio(
    segments: { start: number, end: number, text: string }[],
    outputDir: string,
    videoId: string,
    onProgress?: ProgressCallback
) {
    const segmentFiles: string[] = [];

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (!segment.text || segment.text.trim() === '') continue;

        // Skip sound effect descriptions in brackets like [მექანიკური ხმა]
        const cleanText = segment.text.replace(/\[.*?\]/g, '').trim();
        if (!cleanText) continue;

        const fileName = path.join(outputDir, `${videoId}_segment_${i}.mp3`);

        try {
            console.log(`Generating TTS for segment ${i}/${segments.length}: "${cleanText.substring(0, 30)}..."`);

            // Report progress
            if (onProgress) {
                onProgress(i + 1, segments.length, cleanText, 'tts');
            }

            await generateSpeechEdge(cleanText, fileName);
            segmentFiles.push(fileName);

            // Small delay between requests
            await new Promise(r => setTimeout(r, 800));
        } catch (error: any) {
            console.error(`Error in TTS segment ${i}:`, error?.message || String(error));
            // Retry once after a longer delay
            await new Promise(r => setTimeout(r, 2000));
            try {
                await generateSpeechEdge(cleanText, fileName);
                segmentFiles.push(fileName);
            } catch (retryError: any) {
                console.error(`Retry failed for segment ${i}:`, retryError?.message || String(retryError));
            }
            continue;
        }
    }

    return segmentFiles;
}

function getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
            if (err) reject(err);
            else resolve(metadata.format.duration || 0);
        });
    });
}

// Normalize audio volume for consistent loudness
async function normalizeAudio(audioPath: string): Promise<void> {
    const { spawnSync } = require('child_process');

    const tempPath = audioPath.replace('.mp3', '_temp_norm.mp3');

    // Use loudnorm filter for EBU R128 normalization
    // I = integrated loudness target (-14 LUFS is standard for streaming)
    // TP = true peak (-1 dB to avoid clipping)
    // LRA = loudness range (7 for consistent volume)
    const args = [
        '-i', audioPath,
        '-af', 'loudnorm=I=-14:TP=-1:LRA=7',
        '-ar', '24000',
        '-y', tempPath
    ];

    console.log('Normalizing audio volume...');

    const result = spawnSync(FFMPEG_PATH, args, {
        stdio: 'pipe',
        maxBuffer: 50 * 1024 * 1024
    });

    if (result.status !== 0) {
        console.error('Audio normalization failed:', result.stderr?.toString());
        return; // Keep original if normalization fails
    }

    // Replace original with normalized
    fs.unlinkSync(audioPath);
    fs.renameSync(tempPath, audioPath);

    console.log('Audio normalization complete.');
}

// Speed up audio to fit target duration
async function adjustAudioSpeed(inputPath: string, outputPath: string, targetDuration: number): Promise<void> {
    const { spawnSync } = require('child_process');

    const actualDuration = await getAudioDuration(inputPath);

    if (actualDuration <= targetDuration) {
        // No need to speed up, just copy
        fs.copyFileSync(inputPath, outputPath);
        return;
    }

    const speedFactor = actualDuration / targetDuration;

    // atempo filter accepts values between 0.5 and 2.0
    // For higher speeds, we chain multiple atempo filters
    let atempoFilters: string[] = [];
    let remainingFactor = speedFactor;

    while (remainingFactor > 2.0) {
        atempoFilters.push('atempo=2.0');
        remainingFactor /= 2.0;
    }
    if (remainingFactor > 1.0) {
        atempoFilters.push(`atempo=${remainingFactor.toFixed(4)}`);
    }

    if (atempoFilters.length === 0) {
        fs.copyFileSync(inputPath, outputPath);
        return;
    }

    const filterString = atempoFilters.join(',');

    const args = [
        '-i', inputPath,
        '-filter:a', filterString,
        '-y', outputPath
    ];

    const result = spawnSync(FFMPEG_PATH, args, {
        stdio: 'pipe',
        maxBuffer: 50 * 1024 * 1024
    });

    if (result.status !== 0) {
        console.error('Speed adjustment failed, using original');
        fs.copyFileSync(inputPath, outputPath);
    }
}

export async function stitchAudioWithTiming(
    segments: { start: number, end: number, audioPath: string }[],
    outputPath: string,
    totalDuration: number,
    onProgress?: ProgressCallback
) {
    const { spawnSync } = require('child_process');

    if (onProgress) {
        onProgress(0, 1, 'აუდიო სეგმენტების სინქრონიზაცია...', 'stitch');
    }

    // Sort segments by start time
    const sortedSegments = [...segments].sort((a, b) => a.start - b.start);

    // Process each segment - place at EXACT timestamp, speed up only if overlapping
    const adjustedSegments = [];

    for (let i = 0; i < sortedSegments.length; i++) {
        const segment = sortedSegments[i];

        if (!fs.existsSync(segment.audioPath)) {
            console.log(`Skipping segment ${i}: file not found`);
            continue;
        }

        const ttsDuration = await getAudioDuration(segment.audioPath);
        const targetDuration = segment.end - segment.start;

        // Calculate available time until next segment starts
        let availableTime = targetDuration;
        if (i < sortedSegments.length - 1) {
            const nextStart = sortedSegments[i + 1].start;
            // Use the smaller value - either target duration or time until next segment
            availableTime = Math.min(targetDuration, nextStart - segment.start);
            // Ensure at least 0.5s to avoid issues with very short gaps
            availableTime = Math.max(availableTime, 0.5);
        }

        // Determine if we need to speed up
        let adjustedPath = segment.audioPath;
        let finalDuration = ttsDuration;

        if (ttsDuration > availableTime) {
            // Need to speed up to fit before next segment
            const speedFactor = ttsDuration / availableTime;
            const maxSpeedup = 3.0; // Limit speedup to 3.0x for quality

            if (speedFactor <= maxSpeedup) {
                // Speed up to fit
                adjustedPath = segment.audioPath.replace('.mp3', '_adjusted.mp3');
                await adjustAudioSpeed(segment.audioPath, adjustedPath, availableTime);
                finalDuration = await getAudioDuration(adjustedPath);
                console.log(`Segment ${i}: ${ttsDuration.toFixed(2)}s → ${finalDuration.toFixed(2)}s (${speedFactor.toFixed(2)}x speedup)`);
            } else {
                // Too much speedup needed - cap at max speedup
                adjustedPath = segment.audioPath.replace('.mp3', '_adjusted.mp3');
                const cappedDuration = ttsDuration / maxSpeedup;
                await adjustAudioSpeed(segment.audioPath, adjustedPath, cappedDuration);
                finalDuration = await getAudioDuration(adjustedPath);
                console.log(`Segment ${i}: ${ttsDuration.toFixed(2)}s → ${finalDuration.toFixed(2)}s (capped at ${maxSpeedup}x)`);
            }
        } else {
            console.log(`Segment ${i}: ${ttsDuration.toFixed(2)}s (no adjustment, fits in ${availableTime.toFixed(2)}s)`);
        }

        adjustedSegments.push({
            ...segment,
            audioPath: adjustedPath,
            originalPath: segment.audioPath, // Keep track of original for cleanup
            wasAdjusted: adjustedPath !== segment.audioPath,
            audioDuration: finalDuration,
            exactStart: segment.start // Keep exact original timestamp
        });
    }

    if (onProgress) {
        onProgress(0, 1, 'აუდიო ფაილების გაერთიანება...', 'stitch');
    }

    // Use EXACT timestamps from transcript - no drift adjustment
    console.log('Using exact timestamps from YouTube transcript:');
    for (let i = 0; i < adjustedSegments.length; i++) {
        const seg = adjustedSegments[i];
        console.log(`  Segment ${i}: starts at ${seg.exactStart.toFixed(2)}s, duration ${seg.audioDuration.toFixed(2)}s`);
    }

    // Build filter complex - use exact timestamps
    let filters = [];

    for (let i = 0; i < adjustedSegments.length; i++) {
        // Use exactStart for precise placement at transcript timestamps
        const delayMs = Math.floor(adjustedSegments[i].exactStart * 1000);
        filters.push(`[${i}]adelay=${delayMs}|${delayMs}[a${i}]`);
    }

    const mixInputs = adjustedSegments.map((_, i) => `[a${i}]`).join('');
    // normalize=0 prevents amix from dividing volume by number of inputs
    // weights sets equal weight for all inputs
    const weights = adjustedSegments.map(() => '1').join(' ');
    const filterComplex = filters.join(';') + `;${mixInputs}amix=inputs=${adjustedSegments.length}:duration=longest:dropout_transition=0:normalize=0:weights=${weights}[out]`;

    // Write filter to a temp file to avoid Windows command line length limits
    const filterScriptPath = outputPath.replace('.mp3', '_filter.txt');
    fs.writeFileSync(filterScriptPath, filterComplex);

    // Build arguments array - using spawnSync with args array bypasses Windows cmd line limit
    const args: string[] = [];
    for (const segment of adjustedSegments) {
        args.push('-i', segment.audioPath);
    }
    args.push('-filter_complex_script', filterScriptPath);
    args.push('-map', '[out]');
    args.push('-t', String(totalDuration));
    args.push('-y', outputPath);

    console.log('Running ffmpeg stitch command...');
    console.log(`Total segments: ${adjustedSegments.length}, Total duration: ${totalDuration}s`);

    try {
        const result = spawnSync(FFMPEG_PATH, args, {
            stdio: 'pipe',
            maxBuffer: 50 * 1024 * 1024,
            windowsVerbatimArguments: true
        });

        if (result.status !== 0) {
            const stderr = result.stderr?.toString() || 'Unknown error';
            throw new Error(`ffmpeg exited with code ${result.status}: ${stderr}`);
        }

        console.log('Audio stitching complete.');

        // Cleanup temp files - only delete adjusted versions, not originals
        fs.unlinkSync(filterScriptPath);
        for (const segment of adjustedSegments) {
            if (segment.wasAdjusted) {
                try { fs.unlinkSync(segment.audioPath); } catch {}
            }
        }

        // Normalize audio volume
        if (onProgress) {
            onProgress(0, 1, 'აუდიოს ნორმალიზაცია...', 'stitch');
        }

        await normalizeAudio(outputPath);

        if (onProgress) {
            onProgress(1, 1, 'დასრულდა!', 'stitch');
        }
    } catch (error: any) {
        console.error('ffmpeg stitch error:', error.message);
        // Cleanup temp files on error too - only adjusted versions
        try { fs.unlinkSync(filterScriptPath); } catch {}
        for (const segment of adjustedSegments) {
            if (segment.wasAdjusted) {
                try { fs.unlinkSync(segment.audioPath); } catch {}
            }
        }
        throw error;
    }
}
