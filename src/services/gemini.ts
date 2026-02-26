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

// Translate text segments from YouTube transcript (keeping original timestamps)
export async function translateTranscript(segments: TranscriptSegment[]): Promise<TranscriptSegment[]> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        throw new Error("GOOGLE_API_KEY is not defined in .env.local");
    }

    // Prepare the segments as numbered list for translation
    const textList = segments.map((seg, i) => `${i}: ${seg.text}`).join('\n');

    const prompt = `
Translate the following English text segments to Georgian (ქართული).
Each line starts with a number followed by the English text.
Return ONLY a JSON array where each element has "index" (the segment number) and "text" (Georgian translation).

IMPORTANT:
- Keep translations natural and conversational
- Maintain the meaning accurately
- Return the same number of segments

Text segments to translate:
${textList}

Return format:
[{"index": 0, "text": "ქართული თარგმანი"}, {"index": 1, "text": "..."}, ...]
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const payload = {
        contents: [
            {
                parts: [{ text: prompt }],
            },
        ],
        generationConfig: {
            responseMimeType: "application/json"
        }
    };

    try {
        console.log(`Translating ${segments.length} segments with Gemini...`);
        const response = await axios.post(url, payload, {
            headers: {
                "Content-Type": "application/json",
            },
        });

        const candidate = response.data.candidates[0];
        const text = candidate.content.parts[0].text;

        console.log("Translation received from Gemini.");

        // Extract JSON from potential markdown/text
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.error("Gemini raw text:", text);
            throw new Error("Failed to parse Gemini translation response as JSON array");
        }

        const translations = JSON.parse(jsonMatch[0]);

        // Map translations back to segments with original timestamps
        // Track used indices to prevent duplicates from Gemini
        const usedIndices = new Set<number>();
        const result: TranscriptSegment[] = [];
        for (const trans of translations) {
            const originalIndex = trans.index;
            if (originalIndex !== undefined && originalIndex < segments.length && !usedIndices.has(originalIndex)) {
                usedIndices.add(originalIndex);
                result.push({
                    start: segments[originalIndex].start,
                    end: segments[originalIndex].end,
                    text: trans.text
                });
            }
        }

        // Sort by start time to ensure correct order
        result.sort((a, b) => a.start - b.start);

        console.log(`Successfully translated ${result.length} segments`);
        return result;

    } catch (error: any) {
        if (error.response) {
            console.error("Gemini REST Error status:", error.response.status);
            console.error("Gemini REST Error data:", JSON.stringify(error.response.data, null, 2));
        }
        throw new Error(`Gemini Translation Failed: ${error.message}`);
    }
}
