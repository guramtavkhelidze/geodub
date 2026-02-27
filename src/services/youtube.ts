import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execPromise = promisify(exec);

// Extract clean video URL (remove tracking params like &pp=)
function cleanYouTubeUrl(url: string): string {
  const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL format');
  return `https://www.youtube.com/watch?v=${videoIdMatch[1]}`;
}

export async function downloadYouTubeAudio(url: string, outputDir: string): Promise<{ audioPath: string, videoId: string }> {
  const cleanUrl = cleanYouTubeUrl(url);
  const videoIdMatch = cleanUrl.match(/v=([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL format');

  const videoId = videoIdMatch[1];
  const audioPath = path.join(outputDir, `${videoId}.mp3`);

  if (fs.existsSync(audioPath)) {
    return { audioPath, videoId };
  }

  // Use yt-dlp to download audio
  const ffmpegLocation = process.env.FFMPEG_LOCATION;
  const ffmpegArg = ffmpegLocation ? `--ffmpeg-location "${ffmpegLocation}"` : '';
  try {
    await execPromise(`python -m yt_dlp -x --audio-format mp3 ${ffmpegArg} -o "${audioPath}" "${cleanUrl}"`);
  } catch (error: any) {
    console.error('Error downloading audio:', error);
    throw new Error(`Failed to download YouTube audio. Details: ${error.message}`);
  }

  return { audioPath, videoId };
}

export async function getVideoMetadata(url: string) {
  const cleanUrl = cleanYouTubeUrl(url);
  const ffmpegLocation = process.env.FFMPEG_LOCATION;
  const ffmpegArg = ffmpegLocation ? `--ffmpeg-location "${ffmpegLocation}"` : '';

  try {
    const { stdout } = await execPromise(`python -m yt_dlp ${ffmpegArg} --dump-json "${cleanUrl}"`);
    return JSON.parse(stdout);
  } catch (error: any) {
    console.error('Error fetching metadata:', error);
    throw new Error(`Failed to fetch video metadata. Details: ${error.message}`);
  }
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export async function getYouTubeTranscript(url: string, outputDir: string): Promise<TranscriptSegment[]> {
  const cleanUrl = cleanYouTubeUrl(url);
  const videoIdMatch = cleanUrl.match(/v=([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL format');

  const videoId = videoIdMatch[1];
  const subtitlePath = path.join(outputDir, `${videoId}_subs`);
  const ffmpegLocation = process.env.FFMPEG_LOCATION;
  const ffmpegArg = ffmpegLocation ? `--ffmpeg-location "${ffmpegLocation}"` : '';

  try {
    // Download auto-generated or manual subtitles in JSON3 format (has precise timestamps)
    // Try English first, then any available language
    await execPromise(
      `python -m yt_dlp ${ffmpegArg} --write-auto-sub --write-sub --sub-lang "en.*,en" --sub-format json3 --skip-download -o "${subtitlePath}" "${cleanUrl}"`,
      { maxBuffer: 50 * 1024 * 1024 }
    );

    // Find the downloaded subtitle file
    const files = fs.readdirSync(outputDir);
    const subFile = files.find(f => f.startsWith(`${videoId}_subs`) && f.endsWith('.json3'));

    if (!subFile) {
      throw new Error('No subtitles found for this video');
    }

    const subContent = fs.readFileSync(path.join(outputDir, subFile), 'utf-8');
    const subData = JSON.parse(subContent);

    // Parse JSON3 format - events contain segments with timestamps
    const segments: TranscriptSegment[] = [];

    if (subData.events) {
      for (const event of subData.events) {
        // Skip events without segments (like blank lines)
        if (!event.segs || event.tStartMs === undefined) continue;

        const startMs = event.tStartMs;
        const durationMs = event.dDurationMs || 0;

        // Combine all text segments in this event
        let text = '';
        for (const seg of event.segs) {
          if (seg.utf8) {
            text += seg.utf8;
          }
        }

        text = text.trim();
        if (!text || text === '\n') continue;

        segments.push({
          start: startMs / 1000,
          end: (startMs + durationMs) / 1000,
          text: text
        });
      }
    }

    // Clean up subtitle file
    try {
      fs.unlinkSync(path.join(outputDir, subFile));
    } catch {}

    // Merge very short consecutive segments (under 0.5s) into larger ones for better TTS
    const mergedSegments: TranscriptSegment[] = [];
    let currentSegment: TranscriptSegment | null = null;

    for (const seg of segments) {
      if (!currentSegment) {
        currentSegment = { ...seg };
        continue;
      }

      // If this segment starts right after the previous one and combined duration < 10s
      const gap = seg.start - currentSegment.end;
      const combinedDuration = seg.end - currentSegment.start;

      if (gap < 0.3 && combinedDuration < 10) {
        // Merge
        currentSegment.end = seg.end;
        currentSegment.text += ' ' + seg.text;
      } else {
        // Push current and start new
        mergedSegments.push(currentSegment);
        currentSegment = { ...seg };
      }
    }

    if (currentSegment) {
      mergedSegments.push(currentSegment);
    }

    console.log(`Found ${segments.length} subtitle segments, merged to ${mergedSegments.length}`);
    return mergedSegments;

  } catch (error: any) {
    console.error('Error fetching transcript:', error);
    throw new Error(`Failed to fetch YouTube transcript: ${error.message}`);
  }
}
