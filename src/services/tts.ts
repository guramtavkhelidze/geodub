import { generateSpeechEdge } from './edge-tts';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const FFMPEG_PATH = 'C:\\Users\\Guram\\OneDrive\\Desktop\\Targmna\\ffmpeg-8.0.1-essentials_build\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
const FFPROBE_PATH = 'C:\\Users\\Guram\\OneDrive\\Desktop\\Targmna\\ffmpeg-8.0.1-essentials_build\\ffmpeg-8.0.1-essentials_build\\bin\\ffprobe.exe';

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

type ProgressCallback = (current: number, total: number, text: string, stage: string) => void;

export class CancellationError extends Error {
    constructor() { super('Cancelled'); this.name = 'CancellationError'; }
}

export async function generateGeorgianAudio(
    segments: { start: number, end: number, text: string }[],
    outputDir: string,
    videoId: string,
    onProgress?: ProgressCallback,
    isCancelledFn?: () => boolean
) {
    const segmentFiles: string[] = [];

    for (let i = 0; i < segments.length; i++) {
        if (isCancelledFn?.()) throw new CancellationError();

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
            await new Promise(r => setTimeout(r, 500));
        } catch (error: any) {
            console.error(`Error in TTS segment ${i}:`, error.message);
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

    console.log('Running ffmpeg stitch command...');
    console.log(`Total segments: ${adjustedSegments.length}, Total duration: ${totalDuration}s`);

    function runFfmpeg(args: string[]): void {
        const result = spawnSync(FFMPEG_PATH, args, {
            stdio: 'pipe',
            maxBuffer: 50 * 1024 * 1024,
            windowsVerbatimArguments: true,
            timeout: 10 * 60 * 1000, // 10 minute hard limit per ffmpeg call
        });

        if (result.error) {
            throw new Error(`ffmpeg failed to spawn: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const signal = result.signal ? ` (signal: ${result.signal})` : '';
            const stderr = result.stderr?.toString().trim() || 'no stderr output';
            throw new Error(`ffmpeg exited with code ${result.status}${signal}: ${stderr}`);
        }
    }

    // Mix segments in chunks to avoid amix hitting memory/filter-graph limits with 100s of inputs.
    // Each chunk mixes its segments at their RELATIVE timestamps (offset from chunk start),
    // producing a short output covering only that chunk's time range.
    // A final pass stitches chunk files together using silence-padded concat.
    const CHUNK_SIZE = 50;
    const chunkPaths: string[] = [];
    const filterScriptPaths: string[] = [];
    const totalChunks = Math.ceil(adjustedSegments.length / CHUNK_SIZE);

    try {
        for (let chunkStart = 0; chunkStart < adjustedSegments.length; chunkStart += CHUNK_SIZE) {
            const chunk = adjustedSegments.slice(chunkStart, chunkStart + CHUNK_SIZE);
            const chunkIndex = Math.floor(chunkStart / CHUNK_SIZE);
            const chunkPath = outputPath.replace('.mp3', `_chunk${chunkIndex}.mp3`);
            chunkPaths.push(chunkPath);

            // Use relative timestamps: subtract the chunk's start time so the output
            // only spans the chunk's time range rather than the full video duration.
            const chunkOffsetMs = Math.floor(chunk[0].exactStart * 1000);

            const filters: string[] = [];
            for (let i = 0; i < chunk.length; i++) {
                const relativeDelayMs = Math.floor(chunk[i].exactStart * 1000) - chunkOffsetMs;
                filters.push(`[${i}]adelay=${relativeDelayMs}|${relativeDelayMs}[a${i}]`);
            }
            const mixInputs = chunk.map((_, i) => `[a${i}]`).join('');
            const weights = chunk.map(() => '1').join(' ');
            const filterComplex = filters.join(';') + `;${mixInputs}amix=inputs=${chunk.length}:duration=longest:dropout_transition=0:normalize=0:weights=${weights}[out]`;

            const filterScriptPath = outputPath.replace('.mp3', `_filter_chunk${chunkIndex}.txt`);
            filterScriptPaths.push(filterScriptPath);
            fs.writeFileSync(filterScriptPath, filterComplex);

            const args: string[] = [];
            for (const seg of chunk) args.push('-i', seg.audioPath);
            args.push('-filter_complex_script', filterScriptPath);
            args.push('-map', '[out]');
            // No -t here: let each chunk end naturally at its last segment's end.
            // This keeps chunk files small (only their portion of the timeline).
            args.push('-y', chunkPath);

            console.log(`Mixing chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} segs, offset ${(chunkOffsetMs/1000).toFixed(1)}s)...`);
            if (onProgress) {
                onProgress(chunkIndex, totalChunks, `სეგმენტების დამუშავება: ${chunkIndex + 1}/${totalChunks}`, 'stitch');
            }
            runFfmpeg(args);
        }

        // Final pass: concat chunk files with silence padding between them.
        // Each chunk covers [chunkOffsetSec .. chunkOffsetSec + chunkDuration].
        // We pad gaps with silence using lavfi aevalsrc so chunks sit at their correct positions.
        if (onProgress) {
            onProgress(totalChunks, totalChunks, 'ფინალური გაერთიანება...', 'stitch');
        }

        let finalFilterScript: string | null = null;
        if (chunkPaths.length === 1) {
            const SAMPLE_RATE = 24000;
            const firstSegStart = adjustedSegments[0].exactStart;
            if (firstSegStart > 0.02) {
                // Prepend initial silence so the audio aligns with the video timeline
                const silencePath = outputPath.replace('.mp3', '_silence_0.mp3');
                const concatListPath = outputPath.replace('.mp3', '_concat_list.txt');
                finalFilterScript = concatListPath;
                runFfmpeg([
                    '-f', 'lavfi',
                    '-i', `aevalsrc=0:c=mono:s=${SAMPLE_RATE}:d=${firstSegStart.toFixed(3)}`,
                    '-y', silencePath
                ]);
                fs.writeFileSync(concatListPath, [
                    `file '${silencePath.replace(/\\/g, '/')}'`,
                    `file '${chunkPaths[0].replace(/\\/g, '/')}'`,
                ].join('\n'));
                runFfmpeg([
                    '-f', 'concat', '-safe', '0',
                    '-i', concatListPath,
                    '-c:a', 'libmp3lame', '-q:a', '2',
                    '-y', outputPath
                ]);
                try { fs.unlinkSync(silencePath); } catch {}
            } else {
                fs.renameSync(chunkPaths[0], outputPath);
            }
        } else {
            // Build a concat list that interleaves silence + chunk audio.
            // We use the concat demuxer (file list) for simplicity.
            // Sample rate from edge-tts is 24000 Hz, mono.
            const SAMPLE_RATE = 24000;
            const concatListPath = outputPath.replace('.mp3', '_concat_list.txt');
            finalFilterScript = concatListPath;

            let concatLines: string[] = [];
            let cursorSec = 0;

            for (let ci = 0; ci < chunkPaths.length; ci++) {
                const chunkOffsetSec = adjustedSegments[ci * CHUNK_SIZE].exactStart;
                const gap = chunkOffsetSec - cursorSec;

                if (gap > 0.02) {
                    // Generate a silence file for this gap
                    const silencePath = outputPath.replace('.mp3', `_silence_${ci}.mp3`);
                    const silenceArgs = [
                        '-f', 'lavfi',
                        '-i', `aevalsrc=0:c=mono:s=${SAMPLE_RATE}:d=${gap.toFixed(3)}`,
                        '-y', silencePath
                    ];
                    runFfmpeg(silenceArgs);
                    concatLines.push(`file '${silencePath.replace(/\\/g, '/')}'`);
                }

                concatLines.push(`file '${chunkPaths[ci].replace(/\\/g, '/')}'`);

                // Advance cursor by chunk's actual duration
                const chunkDuration = await getAudioDuration(chunkPaths[ci]);
                cursorSec = chunkOffsetSec + chunkDuration;
            }

            // Pad tail if needed
            const tailGap = totalDuration - cursorSec;
            if (tailGap > 0.02) {
                const silencePath = outputPath.replace('.mp3', '_silence_tail.mp3');
                runFfmpeg([
                    '-f', 'lavfi',
                    '-i', `aevalsrc=0:c=mono:s=${SAMPLE_RATE}:d=${tailGap.toFixed(3)}`,
                    '-y', silencePath
                ]);
                concatLines.push(`file '${silencePath.replace(/\\/g, '/')}'`);
            }

            fs.writeFileSync(concatListPath, concatLines.join('\n'));

            console.log(`Concatenating ${chunkPaths.length} chunks via concat demuxer...`);
            runFfmpeg([
                '-f', 'concat',
                '-safe', '0',
                '-i', concatListPath,
                '-c:a', 'libmp3lame',
                '-q:a', '2',
                '-y', outputPath
            ]);

            // Clean up silence files
            for (let ci = 0; ci <= chunkPaths.length; ci++) {
                const sp = outputPath.replace('.mp3', `_silence_${ci}.mp3`);
                try { fs.unlinkSync(sp); } catch {}
            }
            try { fs.unlinkSync(outputPath.replace('.mp3', '_silence_tail.mp3')); } catch {}
        }

        console.log('Audio stitching complete.');

        // Cleanup
        for (const p of filterScriptPaths) try { fs.unlinkSync(p); } catch {}
        if (finalFilterScript) try { fs.unlinkSync(finalFilterScript); } catch {} // concat list
        for (const cp of chunkPaths) try { fs.unlinkSync(cp); } catch {}
        for (const segment of adjustedSegments) {
            if (segment.wasAdjusted) try { fs.unlinkSync(segment.audioPath); } catch {}
        }

        if (onProgress) onProgress(0, 1, 'აუდიოს ნორმალიზაცია...', 'stitch');
        await normalizeAudio(outputPath);
        if (onProgress) onProgress(1, 1, 'დასრულდა!', 'stitch');

    } catch (error: any) {
        console.error('ffmpeg stitch error:', error.message);
        for (const p of filterScriptPaths) try { fs.unlinkSync(p); } catch {}
        for (const cp of chunkPaths) try { fs.unlinkSync(cp); } catch {}
        for (const segment of adjustedSegments) {
            if (segment.wasAdjusted) try { fs.unlinkSync(segment.audioPath); } catch {}
        }
        throw error;
    }
}
