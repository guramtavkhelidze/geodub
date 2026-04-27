import fs from "fs";
import axios from "axios";

interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
}

export async function translateAudio(audioPath: string) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        throw new Error("GOOGLE_API_KEY is not defined in .env.local");
    }

    if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`);
    }

    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString("base64");

    const prompt = `
    Listen to this audio and provide a synchronized Georgian translation.
    Return the result ONLY as a JSON array of objects with the following format:
    [
      { "start": number, "end": number, "text": "Georgian translation" }
    ]
    The start and end times should be in seconds.
    Ensure the translation flows naturally and matches the timing of the original speech.
  `;

    // Construct raw REST request to bypass SDK bug
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const payload = {
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: "audio/mpeg",
                            data: base64Audio,
                        },
                    },
                ],
            },
        ],
        generationConfig: {
            responseMimeType: "application/json"
        }
    };

    try {
        console.log("Sending REST request to Gemini API...");
        const response = await axios.post(url, payload, {
            headers: {
                "Content-Type": "application/json",
            },
        });

        const candidate = response.data.candidates[0];
        const text = candidate.content.parts[0].text;

        console.log("Gemini Response received.");

        // Extract JSON from potential markdown/text
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.error("Gemini raw text:", text);
            throw new Error("Failed to parse Gemini response as JSON array");
        }

        return JSON.parse(jsonMatch[0]);
    } catch (error: any) {
        if (error.response) {
            console.error("Gemini REST Error status:", error.response.status);
            console.error("Gemini REST Error data:", JSON.stringify(error.response.data, null, 2));
        }
        throw new Error(`Gemini Translation Failed (REST): ${error.message}`);
    }
}

const TRANSLATION_BATCH_SIZE = 200;

async function translateBatch(
    segments: TranscriptSegment[],
    batchOffset: number,
    apiKey: string
): Promise<TranscriptSegment[]> {
    const textList = segments.map((seg, i) => `${i}: ${seg.text}`).join('\n');

    const prompt = `Translate the following English text segments to Georgian (ქართული).
Each line starts with a number followed by the English text.
Return ONLY a JSON array where each element has "index" (the segment number) and "text" (Georgian translation).

IMPORTANT:
- Keep translations natural and conversational
- Maintain the meaning accurately
- Return the same number of segments (${segments.length})

Text segments to translate:
${textList}

Return format:
[{"index": 0, "text": "ქართული თარგმანი"}, {"index": 1, "text": "..."}, ...]`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
    };

    const response = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 120000,
    });

    const candidate = response.data.candidates[0];
    const text = candidate.content.parts[0].text;

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Failed to parse Gemini translation response as JSON array");

    const translations = JSON.parse(jsonMatch[0]);

    const usedIndices = new Set<number>();
    const result: TranscriptSegment[] = [];
    for (const trans of translations) {
        const localIndex = trans.index;
        if (localIndex !== undefined && localIndex < segments.length && !usedIndices.has(localIndex)) {
            usedIndices.add(localIndex);
            result.push({
                start: segments[localIndex].start,
                end: segments[localIndex].end,
                text: trans.text
            });
        }
    }

    return result;
}

type TranslateProgressCallback = (current: number, total: number) => void;

// Translate text segments from YouTube transcript (keeping original timestamps)
export async function translateTranscript(
    segments: TranscriptSegment[],
    onProgress?: TranslateProgressCallback
): Promise<TranscriptSegment[]> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        throw new Error("GOOGLE_API_KEY is not defined in .env.local");
    }

    const totalBatches = Math.ceil(segments.length / TRANSLATION_BATCH_SIZE);
    console.log(`Translating ${segments.length} segments in ${totalBatches} batches of ${TRANSLATION_BATCH_SIZE}...`);

    const allTranslated: TranscriptSegment[] = [];

    for (let offset = 0; offset < segments.length; offset += TRANSLATION_BATCH_SIZE) {
        const batch = segments.slice(offset, offset + TRANSLATION_BATCH_SIZE);
        const batchNum = Math.floor(offset / TRANSLATION_BATCH_SIZE) + 1;

        console.log(`Translating batch ${batchNum}/${totalBatches} (segments ${offset}–${offset + batch.length - 1})...`);
        onProgress?.(batchNum, totalBatches);

        try {
            const translated = await translateBatch(batch, offset, apiKey);
            allTranslated.push(...translated);
        } catch (error: any) {
            if (error.response) {
                console.error("Gemini REST Error status:", error.response.status);
                console.error("Gemini REST Error data:", JSON.stringify(error.response.data, null, 2));
            }
            throw new Error(`Gemini Translation Failed (batch ${batchNum}): ${error.message}`);
        }

        // Brief pause between batches to avoid rate limiting
        if (offset + TRANSLATION_BATCH_SIZE < segments.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    allTranslated.sort((a, b) => a.start - b.start);
    console.log(`Successfully translated ${allTranslated.length}/${segments.length} segments`);
    return allTranslated;
}
