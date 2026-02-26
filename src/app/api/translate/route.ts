import { NextResponse } from 'next/server';
import { downloadYouTubeAudio, getVideoMetadata } from '@/services/youtube';
import { translateAudio } from '@/services/gemini';
import { generateGeorgianAudio, stitchAudioWithTiming } from '@/services/tts';
import path from 'path';
import fs from 'fs';

export async function POST(req: Request) {
    try {
        const { url } = await req.json();
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 });

        const outputDir = path.join(process.cwd(), 'public', 'temp');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        // 1. Download Metadata & Audio
        const metadata = await getVideoMetadata(url);
        const { audioPath, videoId } = await downloadYouTubeAudio(url, outputDir);
        const duration = metadata.duration;

        // 2. Translate with Gemini
        const translationSegments = await translateAudio(audioPath);

        // 3. Generate TTS Segments
        const segmentFiles = await generateGeorgianAudio(translationSegments, outputDir, videoId);

        // 4. Stitch Audio
        // Match segments with their generated files. Note: generateGeorgianAudio might skip some if they fail.
        // We need to ensure we only pass segments that actually have an audio file.
        const segmentsWithPaths = [];
        for (let i = 0; i < translationSegments.length; i++) {
            // Find the segment file if it exists. generateGeorgianAudio uses segment_${i}.mp3 naming.
            const expectedFileName = path.join(outputDir, `${videoId}_segment_${i}.mp3`);
            if (fs.existsSync(expectedFileName)) {
                segmentsWithPaths.push({
                    ...translationSegments[i],
                    audioPath: expectedFileName
                });
            }
        }

        if (segmentsWithPaths.length === 0) {
            throw new Error('Failed to generate any Georgian audio segments.');
        }

        const finalAudioName = `${videoId}_georgian.mp3`;
        const finalAudioPath = path.join(outputDir, finalAudioName);

        await stitchAudioWithTiming(segmentsWithPaths, finalAudioPath, duration);

        return NextResponse.json({
            success: true,
            originalVideoId: videoId,
            translatedAudioUrl: `/temp/${finalAudioName}`,
            metadata: {
                title: metadata.title,
                thumbnail: metadata.thumbnail
            }
        });

    } catch (error: any) {
        console.error('Translation error:', error);
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
    }
}
