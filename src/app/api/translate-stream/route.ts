import { NextRequest } from 'next/server';
import { downloadYouTubeAudio, getVideoMetadata, getYouTubeTranscript } from '@/services/youtube';
import { translateTranscript, translateAudio } from '@/services/gemini';
import { generateGeorgianAudio, stitchAudioWithTiming, CancellationError } from '@/services/tts';
import { isCancelled, clearJob } from '@/services/cancellation';
import path from 'path';
import fs from 'fs';

export async function POST(req: NextRequest) {
    const { url } = await req.json();

    if (!url) {
        return new Response(JSON.stringify({ error: 'URL is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const jobId = crypto.randomUUID();
            const sendProgress = (data: any) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            };
            const checkCancelled = () => isCancelled(jobId);

            try {
                const outputDir = path.join(process.cwd(), 'public', 'temp');
                if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

                // Send jobId so client can cancel
                sendProgress({ stage: 'init', jobId });

                // Stage 1: Download & Get Transcript
                sendProgress({ stage: 'download', message: 'ვიდეოს ინფორმაციის ჩამოტვირთვა...' });
                const metadata = await getVideoMetadata(url);
                const { audioPath, videoId } = await downloadYouTubeAudio(url, outputDir);
                const duration = metadata.duration;

                // Send videoId so client can request cleanup on cancel
                sendProgress({ stage: 'download', message: 'ჩამოტვირთვა დასრულდა...', videoId });

                if (checkCancelled()) throw new CancellationError();

                // Try to get YouTube transcript with precise timestamps
                let translationSegments;
                let usingTranscript = false;

                try {
                    sendProgress({ stage: 'download', message: 'სუბტიტრების ჩამოტვირთვა...' });
                    const transcript = await getYouTubeTranscript(url, outputDir);
                    sendProgress({
                        stage: 'download',
                        message: `მოიძებნა ${transcript.length} სეგმენტი სუბტიტრებიდან`
                    });

                    if (checkCancelled()) throw new CancellationError();

                    // Stage 2: Translate text (using transcript timestamps)
                    sendProgress({ stage: 'translate', message: 'თარგმანის გენერაცია Gemini-ით...' });
                    translationSegments = await translateTranscript(transcript);
                    usingTranscript = true;
                    sendProgress({
                        stage: 'translate',
                        message: `ნათარგმნია ${translationSegments.length} სეგმენტი (სუბტიტრების timestamp-ებით)`,
                        total: translationSegments.length
                    });
                } catch (transcriptError: any) {
                    if (transcriptError instanceof CancellationError) throw transcriptError;
                    // Fallback to audio-based transcription if no subtitles available
                    console.log('No subtitles available, falling back to audio transcription:', transcriptError.message);
                    sendProgress({ stage: 'translate', message: 'სუბტიტრები ვერ მოიძებნა, აუდიოდან ტრანსკრიფცია...' });
                    translationSegments = await translateAudio(audioPath);
                    sendProgress({
                        stage: 'translate',
                        message: `ნათარგმნია ${translationSegments.length} სეგმენტი (აუდიოდან)`,
                        total: translationSegments.length
                    });
                }

                if (checkCancelled()) throw new CancellationError();

                // Stage 3: TTS
                const segmentFiles = await generateGeorgianAudio(
                    translationSegments,
                    outputDir,
                    videoId,
                    (current, total, text, stage) => {
                        sendProgress({
                            stage: 'tts',
                            current,
                            total,
                            text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
                            percent: Math.round((current / total) * 100)
                        });
                    },
                    checkCancelled
                );

                // Stage 4: Stitch
                const segmentsWithPaths = [];
                for (let i = 0; i < translationSegments.length; i++) {
                    const expectedFileName = path.join(outputDir, `${videoId}_segment_${i}.mp3`);
                    if (fs.existsSync(expectedFileName)) {
                        segmentsWithPaths.push({
                            ...translationSegments[i],
                            audioPath: expectedFileName
                        });
                    }
                }

                if (segmentsWithPaths.length === 0) {
                    throw new Error('ვერცერთი აუდიო სეგმენტი ვერ შეიქმნა.');
                }

                const finalAudioName = `${videoId}_georgian.mp3`;
                const finalAudioPath = path.join(outputDir, finalAudioName);

                sendProgress({ stage: 'stitch', message: 'აუდიო ფაილების გაერთიანება...' });

                await stitchAudioWithTiming(
                    segmentsWithPaths,
                    finalAudioPath,
                    duration,
                    (current, total, text, stage) => {
                        sendProgress({ stage: 'stitch', message: text });
                    }
                );

                // Save metadata to JSON file for persistence
                const metadataFile = path.join(outputDir, `${videoId}_meta.json`);
                const metaToSave = {
                    title: metadata.title,
                    thumbnail: metadata.thumbnail,
                    duration: metadata.duration,
                    createdAt: new Date().toISOString()
                };
                fs.writeFileSync(metadataFile, JSON.stringify(metaToSave, null, 2));

                // Done
                sendProgress({
                    stage: 'done',
                    success: true,
                    originalVideoId: videoId,
                    translatedAudioUrl: `/temp/${finalAudioName}`,
                    metadata: metaToSave
                });

            } catch (error: any) {
                if (error instanceof CancellationError) {
                    sendProgress({ stage: 'cancelled' });
                } else {
                    console.error('Translation error:', error);
                    sendProgress({ stage: 'error', error: error.message || 'დაფიქსირდა შეცდომა' });
                }
            } finally {
                clearJob(jobId);
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
